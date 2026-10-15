import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import type { ExtensionArtifact } from "@get-halo/client";
import { serverTest } from "../../../test/serverTest.js";
import { buildBooksArtifact, startSupervisor, type Supervisor } from "./appFixtures.js";

const appId = "12345678-1234-1234-1234-123456789abc";
const installId = "11111111-2222-3333-4444-555555555555";
const firstStartTest = serverTest.extend<{ artifact: ExtensionArtifact; supervisor: Supervisor }>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
  artifact: async ({}, use) => await use(await buildBooksArtifact()),
  supervisor: async ({ server }, use) => {
    const supervisor = await startSupervisor(server.workspaceRoot);
    await use(supervisor);
    await supervisor.close();
  },
});

firstStartTest("an install retries a first start that a newly assigned VM missed", async ({ server, createServer, supervisor, artifact }) => {
  const vm = createServer({ workspaceRoot: path.join(server.workspaceRoot, "remote-app"), appDataDir: path.join(server.workspaceRoot, "remote-state"), gateway: { token: "gateway-secret-longer-than-32-characters" }, sharedApp: { appId, extensionId: "books", syncAccess: "read-only" }, extensionRuntime: { executable: process.execPath, electronRunAsNode: false, sandbox: { socketPath: supervisor.socketPath } } });
  supervisor.setRoot(vm.workspaceRoot); await fs.mkdir(vm.workspaceRoot, { recursive: true }); await vm.start();
  supervisor.failAppStarts.value = 1;
  await vm.rpc.extensions.install({ id: "books", artifact, installId });
  expect(supervisor.starts).toEqual(["books--", "books--"]);
  expect(supervisor.running()).toEqual(["books--"]);
  // Two failures in a row still fail the install, with the supervisor's reason.
  supervisor.starts.length = 0;
  const other = createServer({ workspaceRoot: path.join(server.workspaceRoot, "remote-app-2"), appDataDir: path.join(server.workspaceRoot, "remote-state-2"), gateway: { token: "gateway-secret-longer-than-32-characters" }, sharedApp: { appId, extensionId: "books", syncAccess: "read-only" }, extensionRuntime: { executable: process.execPath, electronRunAsNode: false, sandbox: { socketPath: supervisor.socketPath } } });
  supervisor.setRoot(other.workspaceRoot); await fs.mkdir(other.workspaceRoot, { recursive: true }); await other.start();
  supervisor.failAppStarts.value = 2;
  await expect(other.rpc.extensions.install({ id: "books", artifact, installId })).rejects.toThrow(/did not become ready/);
  expect(supervisor.starts).toEqual(["books--", "books--"]);
});
