import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { writeHaloRpcFile } from "@get-halo/shared/HaloRpcFile";
import { app as appCli } from "../../../../../packages/halo-cli/src/app.js";
import { appWorldTest, signIn } from "./appWorld.js";
import { connectPages, startPagesApi } from "./pagesApi.js";

vi.setConfig({ testTimeout: 90_000 });

appWorldTest("the owner's agent publishes and edits apps with halo app", async ({ appDataDir, plane, provider }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  await owner.rpc.workspace.ensure();
  const vm = provider.ownerVm();
  const userData = path.join(vm.root, "cli");
  await fs.mkdir(userData, { recursive: true });
  const written = await writeHaloRpcFile({ userDataDir: userData, connection: vm.server.ready.connections.cli });
  if (written instanceof Error) throw written;
  // The CLI runs in-process with the agent's environment, as `halo app …`.
  const halo = async (...argv: string[]) => {
    const output: string[] = [];
    const exit: number[] = [];
    await appCli.serve([...argv, "--format", "json"], { env: { HALO_USER_DATA: userData }, stdout: (text) => output.push(text), exit: (code) => exit.push(code) });
    const text = output.join("");
    return { code: exit[0] ?? 0, text, json: (() => { try { return JSON.parse(text) as unknown; } catch { return undefined; } })() };
  };
  // A failed publication is undone from the CLI; the extension runs locally again.
  provider.failAppEnsures = 1;
  expect((await halo("publish", "books")).code).not.toBe(0);
  const [stuck] = (await halo("list")).json as { appId: string; stage: string }[];
  expect(stuck).toMatchObject({ stage: "publishing" });
  expect((await halo("cancel", stuck!.appId)).json).toEqual({ cancelled: stuck!.appId });
  expect((await halo("list")).json).toEqual([]);
  expect((await halo("cancel", stuck!.appId)).code).not.toBe(0);
  const published = await halo("publish", "books", "--invite", "friend@example.com");
  expect(published.code).toBe(0);
  expect(published.json).toMatchObject({ extensionId: "books", visibility: "invited", members: ["friend@example.com"], stage: "live" });
  const appId = (published.json as { appId: string }).appId;
  expect((await halo("list")).json).toMatchObject([{ appId }]);
  const source = path.join(vm.root, "edited.ts");
  await fs.writeFile(source, "// edited by the agent");
  expect((await halo("write", appId, "api.ts", "--file", source)).code).toBe(0);
  expect((await halo("read", appId, "api.ts")).json).toBe("// edited by the agent");
  expect((await halo("exec", appId, "npm run build")).json).toEqual({ output: "npm run build", exitCode: 0 });
  expect((await halo("restart", appId)).code).toBe(0);
  expect((await halo("unpublish", appId)).json).toMatchObject({ published: false });
  const pages = await startPagesApi();
  try {
    const { address } = await connectPages({ owner, endpoint: pages.endpoint, origin: plane.origin, provider });
    const actions = path.join(vm.root, "actions.json");
    await fs.writeFile(actions, JSON.stringify([{ name: "addPage", description: "Add a page", address, arguments: { database: "reading-db", title: "x" } }]));
    expect((await halo("bind-actions", appId, "--file", actions)).json).toMatchObject({ actions: [{ name: "addPage" }] });
    expect((await halo("bind-actions", appId, "--file", path.join(vm.root, "missing.json"))).code).not.toBe(0);
    await fs.writeFile(actions, JSON.stringify([{ name: "addPage", description: "Add", address: "pages.main.missing", arguments: {} }]));
    expect((await halo("bind-actions", appId, "--file", actions)).code).not.toBe(0);
    await fs.writeFile(actions, "{");
    expect((await halo("bind-actions", appId, "--file", actions)).code).not.toBe(0);
  } finally {
    await pages.close();
  }
  await provider.client(appId).extensions.writeSource({ id: "books", name: "sample-data.json", contents: "{}" });
  expect((await halo("template", appId, "--slug", "books", "--description", "Track reading")).json).toMatchObject({ slug: "books", description: "Track reading" });
  expect((await halo("template", appId, "--slug", "Bad Slug", "--description", "x")).code).not.toBe(0);
  // Failures surface as CLI errors.
  expect((await halo("read", appId, "../secret")).code).not.toBe(0);
  expect((await halo("write", appId, "api.ts", "--file", path.join(vm.root, "missing.ts"))).code).not.toBe(0);
  expect((await halo("publish", "missing")).code).not.toBe(0);
  for (const command of [["list"], ["cancel", appId], ["unpublish", appId], ["exec", appId, "x"], ["restart", appId], ["bind-actions", appId, "--file", path.join(vm.root, "actions.json")], ["read", appId, "api.ts"], ["write", appId, "api.ts", "--file", source]]) {
    const output: number[] = [];
    await appCli.serve([...command, "--format", "json"], { env: { HALO_RPC_FILE: path.join(vm.root, "no-rpc.json") }, stdout: () => undefined, exit: (code) => output.push(code) });
    expect(output[0]).not.toBe(0);
  }
});
