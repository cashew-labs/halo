import fs from "node:fs/promises";
import path from "node:path";
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
  artifact: async ({}, use) => await use(await buildBooksArtifact()),
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
  await fs.writeFile(path.join(vm.workspaceRoot, ".halo/extensions/books/dist/start.mjs"), "process.exit(1)");
  await expect(vm.rpc.extensions.snapshot({ id: "books" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await vm.rpc.extensions.list()).toEqual([]);
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
