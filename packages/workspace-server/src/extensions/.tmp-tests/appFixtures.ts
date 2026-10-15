import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { build } from "esbuild";
import type { ExtensionArtifact } from "@get-halo/client";

export const buildId = "01234567-1234-1234-1234-123456789abc";
const sdk = path.resolve(import.meta.dirname, "../../../../extension-sdk/src");

/** A real SDK backend bundle, so tests exercise the actual extension server. */
export async function buildBooksArtifact(ctx: { packageJson?: object; router?: string } = {}): Promise<ExtensionArtifact> {
  const compiled = await build({ bundle: true, platform: "node", format: "esm", target: "node22", write: false, stdin: { resolveDir: sdk, contents: `
    import { runExtension } from ${JSON.stringify(path.join(sdk, "server.ts"))};
    import { os } from ${JSON.stringify(path.join(sdk, "api.ts"))};
    import { defineSchema, defineRelations, collection, t } from ${JSON.stringify(path.join(sdk, "schema.ts"))};
    const schema = defineSchema({ notes: collection({ id: t.id(), text: t.string() }) });
    await runExtension({ schema, relations: defineRelations(schema, () => ({})), publicDirectory: new URL('./public/', import.meta.url).pathname, router: {
      viewer: os.handler(({ context }) => context.viewer),
      token: os.handler(() => process.env.HALO_EXTENSION_TOOLS_TOKEN),
      manage: os.handler(({ context }) => context.tools.files.write({ path: 'api.ts', content: 'public edit' })),
      write: os.handler(async ({ context }) => { const tx = context.storage.transact(); tx.set('notes', { id: 'note', text: 'visitor data' }); await context.storage.commit(tx); }),
      ${ctx.router ?? ""}
    }});
  ` } });
  return {
    files: { "package.json": JSON.stringify(ctx.packageJson ?? { name: "books", halo: { displayName: "Books" } }), "api.ts": "export default {};", "view.tsx": "export default function View() { return null; }", "schema.ts": "export const schema = {};", "helper.sh": "echo hello" },
    assets: { "image.png": Buffer.from([1, 2, 3]).toString("base64") },
    build: {
      "dist/start.mjs": Buffer.from(`await import('./${buildId}/server.mjs');`).toString("base64"),
      "dist/current.json": Buffer.from(JSON.stringify(buildId)).toString("base64"),
      [`dist/${buildId}/server.mjs`]: Buffer.from(compiled.outputFiles[0]!.text).toString("base64"),
      [`dist/${buildId}/public/index.html`]: Buffer.from("<html><head></head><body>Books</body></html>").toString("base64"),
    },
  };
}

/** Write an artifact as an ordinary local extension in an owner workspace. */
export async function writeLocalExtension(ctx: { workspaceRoot: string; id: string; artifact: ExtensionArtifact }) {
  const directory = path.join(ctx.workspaceRoot, ".halo/extensions", ctx.id);
  for (const [name, contents] of Object.entries(ctx.artifact.files)) {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.writeFile(path.join(directory, name), contents);
  }
  for (const [name, contents] of Object.entries({ ...ctx.artifact.assets, ...ctx.artifact.build })) {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.writeFile(path.join(directory, name), Buffer.from(contents, "base64"));
  }
  if (ctx.artifact.data !== undefined) {
    await fs.mkdir(path.join(ctx.workspaceRoot, ".halo/extension-data", ctx.id), { recursive: true });
    await fs.writeFile(path.join(ctx.workspaceRoot, ".halo/extension-data", ctx.id, "tandem.json"), ctx.artifact.data);
  }
}

export type Supervisor = { socketPath: string; setRoot(root: string): void; close(): Promise<void>; commands: string[]; dataDirectory(extensionId: string, instance?: string): string; crashInstances(): void; running(): string[]; failInstanceStarts: { value: boolean }; failAppStarts: { value: number }; starts: string[]; exitCodes: number[] };

// The VM/Docker supervisor is an external host boundary. This fixture exercises
// real workspace and SDK transports; it does not claim to test gVisor isolation.
// Demo instances get their own process and a copy of the installed data.
export async function startSupervisor(root: string): Promise<Supervisor> {
  const directory = path.resolve(import.meta.dirname, "../../../../../tmp/extension-sharing");
  await fs.mkdir(directory, { recursive: true });
  const socketPath = path.relative(process.cwd(), path.join(directory, `socket-${randomUUID().slice(0, 8)}`));
  const state: { root: string; children: Map<string, ChildProcess> } = { root, children: new Map() };
  const commands: string[] = [];
  const failInstanceStarts = { value: false };
  const failAppStarts = { value: 0 };
  const starts: string[] = [];
  const exitCodes: number[] = [];
  const dataDirectory = (extensionId: string, instance?: string) => instance === undefined ? path.join(state.root, ".halo/extension-data", extensionId) : path.join(state.root, ".halo/extension-data", extensionId, "instances", instance);
  const stop = async (name: string) => {
    const child = state.children.get(name);
    state.children.delete(name);
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    child.send("shutdown");
    await once(child, "close");
  };
  const supervisor = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString()) as { extensionId: string; instance?: string; brokerPort: number; hostToken: string; toolToken: string; command: string; syncAccess: string };
    const name = `${input.extensionId}--${input.instance ?? ""}`;
    if (req.url === "/start") {
      await stop(name);
      if (input.instance !== undefined && failInstanceStarts.value) { res.writeHead(400).end(JSON.stringify({ error: "no capacity" })); return; }
      starts.push(name);
      if (input.instance === undefined && failAppStarts.value > 0) { failAppStarts.value -= 1; res.writeHead(400).end(JSON.stringify({ error: "Sandboxed extension did not become ready: running exit 0; " })); return; }
      const data = dataDirectory(input.extensionId, input.instance);
      if (input.instance !== undefined) {
        await fs.mkdir(data, { recursive: true });
        await fs.copyFile(path.join(dataDirectory(input.extensionId), "tandem.json"), path.join(data, "tandem.json")).catch(() => undefined);
      }
      const child = spawn(process.execPath, ["dist/start.mjs", "--port", "0", "--data-dir", data], {
        cwd: path.join(state.root, ".halo/extensions", input.extensionId),
        env: { PATH: process.env.PATH, HALO_EXTENSION_HOST_TOKEN: input.hostToken, HALO_EXTENSION_TOOLS_TOKEN: input.toolToken, HALO_EXTENSION_TOOLS_ORIGIN: `http://127.0.0.1:${input.brokerPort}`, HALO_EXTENSION_SYNC_ACCESS: input.syncAccess },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      state.children.set(name, child);
      const ready = await Promise.race([once(child, "message"), once(child, "close").then(() => undefined)]);
      if (ready === undefined) { res.writeHead(400).end(JSON.stringify({ error: "app exited before ready" })); return; }
      res.end(JSON.stringify({ url: ready[0] }));
    } else if (req.url === "/stop") {
      await stop(name);
      if (input.instance !== undefined) await fs.rm(dataDirectory(input.extensionId, input.instance), { recursive: true, force: true });
      res.end(JSON.stringify({ stopped: true }));
    } else if (req.url === "/reset") {
      for (const name of [...state.children.keys()]) if (name.startsWith(`${input.extensionId}--`) && name !== `${input.extensionId}--`) await stop(name);
      await fs.rm(path.join(dataDirectory(input.extensionId), "instances"), { recursive: true, force: true });
      res.end(JSON.stringify({ reset: true }));
    } else if (req.url === "/status") {
      const child = state.children.get(name);
      res.end(JSON.stringify({ running: child !== undefined && child.exitCode === null && child.signalCode === null }));
    } else if (req.url === "/exec") {
      commands.push(input.command);
      res.end(JSON.stringify({ output: input.command, exitCode: exitCodes.shift() ?? 0 }));
    } else if (req.url === "/snapshot") {
      const data = await fs.readFile(path.join(dataDirectory(input.extensionId), "tandem.json"), "utf8").catch(() => undefined);
      res.end(JSON.stringify({ data }));
    } else res.writeHead(404).end();
  });
  supervisor.listen(socketPath); await once(supervisor, "listening");
  return {
    socketPath,
    commands,
    failInstanceStarts,
    failAppStarts,
    starts,
    exitCodes,
    // Simulates a demo backend dying inside its sandbox.
    running: () => [...state.children].filter(([, child]) => child.exitCode === null && child.signalCode === null).map(([name]) => name),
    crashInstances: () => { for (const [name, child] of state.children) if (!name.endsWith("--")) child.kill("SIGKILL"); },
    dataDirectory,
    setRoot: (next) => { state.root = next; },
    close: async () => {
      for (const name of [...state.children.keys()]) await stop(name);
      await new Promise<void>((resolve) => supervisor.close(() => resolve()));
      await fs.rm(socketPath, { force: true });
    },
  };
}
