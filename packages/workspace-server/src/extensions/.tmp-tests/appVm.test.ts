import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { expect } from "vitest";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ExtensionArtifact } from "@get-halo/client";
import { serverTest } from "../../../test/serverTest.js";
import { buildBooksArtifact, buildId, startSupervisor, type Supervisor } from "./appFixtures.js";

const appId = "12345678-1234-1234-1234-123456789abc";
const gateway = "gateway-secret-longer-than-32-characters";
const installId = "11111111-2222-3333-4444-555555555555";
const otherInstall = "99999999-2222-3333-4444-555555555555";
const appTest = serverTest.extend<{ artifact: ExtensionArtifact; supervisor: Supervisor }>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
  artifact: async ({}, use) => await use(await buildBooksArtifact({ router: `converse: os.handler(({ context }) => context.tools.conversation.send({ viewerToken: context.viewer.token, message: "hi" })),` })),
  supervisor: async ({ server }, use) => {
    const supervisor = await startSupervisor(server.workspaceRoot);
    await use(supervisor);
    await supervisor.close();
  },
});

appTest("dedicated app VM supports owner edits and restarts while rejecting public workspace authority", async ({ server, createServer, supervisor, artifact }) => {
  const vm = createServer({ workspaceRoot: path.join(server.workspaceRoot, "remote-app"), appDataDir: path.join(server.workspaceRoot, "remote-state"), gateway: { token: gateway }, sharedApp: { appId, extensionId: "books", syncAccess: "actions" }, extensionRuntime: { executable: process.execPath, electronRunAsNode: false, sandbox: { socketPath: supervisor.socketPath } } });
  supervisor.setRoot(vm.workspaceRoot); await fs.mkdir(vm.workspaceRoot, { recursive: true }); await vm.start();
  await vm.rpc.extensions.install({ id: "books", artifact, installId });
  // A lost reply is retried with the same install ID without touching the project.
  await vm.rpc.extensions.install({ id: "books", artifact, installId });
  expect(await vm.rpc.extensions.list()).toMatchObject([{ id: "books", displayName: "Books" }]);
  expect(await vm.rpc.extensions.readSource({ id: "books", name: "api.ts" })).toBe("export default {};");
  await vm.rpc.extensions.writeSource({ id: "books", name: "api.ts", contents: "// owner edited remotely" });
  expect(await vm.rpc.extensions.readSource({ id: "books", name: "api.ts" })).toBe("// owner edited remotely");
  for (const name of ["../secret.txt", "/etc/halo/workspace-server.json", ".env", "folder/../../secret.txt"])
    await expect(vm.rpc.extensions.readSource({ id: "books", name })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const api = createORPCClient<{ viewer(): Promise<{ role: string }>; token(): Promise<string>; manage(): Promise<{ ok: boolean }>; write(): Promise<void> }>(new RPCLink({ origin: vm.transport.origin, url: "/extensions/books/api", headers: { authorization: `Bearer ${gateway}`, "x-halo-viewer-role": "public", "x-halo-viewer-id": "visitor" } }));
  expect(await api.viewer()).toMatchObject({ role: "public" });
  expect(await api.manage()).toMatchObject({ ok: false });
  expect(await vm.rpc.extensions.readSource({ id: "books", name: "api.ts" })).toBe("// owner edited remotely");
  await api.write();
  const token = await api.token();
  const publicRpc = createORPCClient<{ extensions: { readSource(input: { id: string; name: string }): Promise<string> } }>(new RPCLink({ origin: vm.transport.origin, url: "/rpc", headers: { authorization: `Bearer ${token}` } }));
  // Without a control plane, the app VM offers no assistant at all.
  expect(await createORPCClient<{ converse(): Promise<unknown> }>(new RPCLink({ origin: vm.transport.origin, url: "/extensions/books/api", headers: { authorization: `Bearer ${gateway}`, "x-halo-viewer-role": "public", "x-halo-viewer-id": "visitor" } })).converse()).toMatchObject({ ok: false });
  await expect(publicRpc.extensions.readSource({ id: "books", name: "api.ts" })).rejects.toMatchObject({ data: { status: 401 } });
  expect(await vm.rpc.extensions.execSource({ id: "books", command: "npm run build" })).toEqual({ output: "npm run build", exitCode: 0 });
  expect(await api.token()).not.toBe(token);
  await expect(vm.rpc.extensions.execSource({ id: "books", command: "x".repeat(8193) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const snapshot = await vm.rpc.extensions.snapshot({ id: "books" });
  expect(snapshot.files["api.ts"]).toBe("// owner edited remotely");
  expect(snapshot.files["helper.sh"]).toBe("echo hello");
  expect(snapshot.assets["image.png"]).toBe(artifact.assets["image.png"]);
  expect(snapshot.build[`dist/${buildId}/public/index.html`]).toBeDefined();
  expect(snapshot.data).toContain("visitor data");
  await expect(vm.rpc.extensions.snapshot({ id: "../other" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  // Compiled output changes only through the build container, not source edits.
  await expect(vm.rpc.extensions.writeSource({ id: "books", name: "dist/current.json", contents: "invalid" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await fs.writeFile(path.join(vm.workspaceRoot, ".halo/extensions/books/dist/current.json"), "invalid");
  await expect(vm.rpc.extensions.snapshot({ id: "books" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(vm.rpc.extensions.install({ id: "books", artifact, installId: otherInstall })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(vm.rpc.extensions.readSource({ id: "other", name: "api.ts" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await fs.writeFile(path.join(vm.workspaceRoot, ".halo/extensions/books/dist/current.json"), JSON.stringify(buildId));
  await fs.writeFile(path.join(vm.workspaceRoot, ".halo/extensions/books/dist/start.mjs"), "process.exit(1)");
  // A failed restart keeps the captured project and the build output.
  expect(Buffer.from((await vm.rpc.extensions.snapshot({ id: "books" })).build["dist/start.mjs"]!, "base64").toString()).toBe("process.exit(1)");
  expect(await vm.rpc.extensions.list()).toEqual([]);
  const failed = await vm.rpc.extensions.execSource({ id: "books", command: "npm run build" });
  expect(failed).toMatchObject({ exitCode: 0 });
  expect(failed.output).toMatch(/^npm run build\nThe app did not restart: /);
});

appTest("shared app assignment refuses an unrestricted fallback when no sandbox is configured", async ({ server, createServer, artifact }) => {
  const vm = createServer({ workspaceRoot: path.join(server.workspaceRoot, "remote-app"), appDataDir: path.join(server.workspaceRoot, "remote-state"), sharedApp: { appId, extensionId: "books", syncAccess: "actions" } });
  await fs.mkdir(vm.workspaceRoot, { recursive: true }); await vm.start();
  await expect(vm.rpc.extensions.install({ id: "books", artifact, installId: otherInstall })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await vm.rpc.extensions.list()).toEqual([]);
});

appTest("ordinary workspaces cannot install or remotely edit an app VM project", async ({ server, artifact }) => {
  for (const operation of [() => server.rpc.extensions.install({ id: "books", artifact, installId }), () => server.rpc.extensions.readSource({ id: "books", name: "api.ts" }), () => server.rpc.extensions.writeSource({ id: "books", name: "api.ts", contents: "x" }), () => server.rpc.extensions.execSource({ id: "books", command: "echo x" })])
    await expect(operation()).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

appTest("demo WebSocket upgrades reach each visitor's own instance", async ({ server, createServer, supervisor }) => {
  const vm = createServer({ workspaceRoot: path.join(server.workspaceRoot, "demo-app"), appDataDir: path.join(server.workspaceRoot, "demo-state"), gateway: { token: gateway }, sharedApp: { appId, extensionId: "demo-books", syncAccess: "shared", demo: true }, extensionRuntime: { executable: process.execPath, electronRunAsNode: false, sandbox: { socketPath: supervisor.socketPath } } });
  supervisor.setRoot(vm.workspaceRoot); await fs.mkdir(vm.workspaceRoot, { recursive: true }); await vm.start();
  const start = `
    import http from "node:http";
    import crypto from "node:crypto";
    const dataDir = process.argv[process.argv.indexOf("--data-dir") + 1];
    const server = http.createServer((_req, res) => res.end("demo"));
    server.on("upgrade", (req, socket) => {
      if (req.headers["x-halo-extension-token"] !== process.env.HALO_EXTENSION_HOST_TOKEN) { socket.end("HTTP/1.1 401 Unauthorized\\r\\n\\r\\n"); return; }
      const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n");
      const body = Buffer.from(JSON.stringify({ dataDir: dataDir.split("/").slice(-2).join("/").slice(0, 60), viewerId: req.headers["x-halo-viewer-id"] }));
      socket.write(Buffer.concat([Buffer.from([129, body.length]), body]));
    });
    server.listen(0, "127.0.0.1", () => process.send("http://127.0.0.1:" + server.address().port + "/view/"));
    process.on("message", () => process.exit());
  `;
  await vm.rpc.extensions.install({ id: "demo-books", installId, artifact: { files: { "package.json": JSON.stringify({ name: "demo-books", halo: { displayName: "Demo" } }) }, assets: {}, build: { "dist/start.mjs": Buffer.from(start).toString("base64"), "dist/current.json": Buffer.from(JSON.stringify(buildId)).toString("base64") }, data: "{}" } });
  const seen: { dataDir: string; viewerId: string }[] = [];
  for (const viewer of ["alice-viewer", "bob-viewer"]) {
    const socket = new WebSocket(`${vm.transport.origin.replace("http:", "ws:")}/extensions/demo-books/sync/`, { headers: { authorization: `Bearer ${gateway}`, "x-halo-viewer-id": viewer, "x-halo-viewer-role": "public" } });
    const [data] = await once(socket, "message");
    seen.push(JSON.parse(data.toString()));
    socket.terminate();
  }
  expect(seen.map((entry) => entry.viewerId)).toEqual(["alice-viewer", "bob-viewer"]);
  expect(seen[0]!.dataDir).toContain("instances");
  expect(seen[0]!.dataDir).not.toBe(seen[1]!.dataDir);
  // A sync upgrade the demo cannot serve is refused with 503 and starts nothing.
  supervisor.failInstanceStarts.value = true;
  const running = supervisor.running().length;
  const refused = new WebSocket(`${vm.transport.origin.replace("http:", "ws:")}/extensions/demo-books/sync/`, { headers: { authorization: `Bearer ${gateway}`, "x-halo-viewer-id": "carol-viewer", "x-halo-viewer-role": "public" } });
  refused.on("error", () => {});
  const [, response] = await once(refused, "unexpected-response");
  expect((response as { statusCode: number }).statusCode).toBe(503);
  expect(supervisor.running()).toHaveLength(running);
});

appTest("other extensions on an app VM never start", async ({ server, createServer, supervisor, artifact }) => {
  const vm = createServer({ workspaceRoot: path.join(server.workspaceRoot, "filter-app"), appDataDir: path.join(server.workspaceRoot, "filter-state"), gateway: { token: gateway }, sharedApp: { appId, extensionId: "books", syncAccess: "actions" }, extensionRuntime: { executable: process.execPath, electronRunAsNode: false, sandbox: { socketPath: supervisor.socketPath } } });
  supervisor.setRoot(vm.workspaceRoot); await fs.mkdir(vm.workspaceRoot, { recursive: true }); await vm.start();
  await vm.rpc.extensions.install({ id: "books", artifact, installId });
  // A second built extension in the app VM's workspace is ignored.
  const other = path.join(vm.workspaceRoot, ".halo/extensions/other");
  await fs.mkdir(path.join(other, "dist"), { recursive: true });
  await fs.writeFile(path.join(other, "package.json"), JSON.stringify({ name: "other" }));
  await fs.writeFile(path.join(other, "dist/start.mjs"), "process.send('http://127.0.0.1:1/view/');");
  await vm.rpc.extensions.reload();
  expect((await vm.rpc.extensions.list()).map((extension) => extension.id)).toEqual(["books"]);
});
