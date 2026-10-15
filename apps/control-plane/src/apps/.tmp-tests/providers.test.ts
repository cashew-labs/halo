import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { workspaceRuntimeConfigFileName } from "@get-halo/config/workspaceServer";
import { LocalWorkspaceProvider } from "../../workspace/provider/local/LocalWorkspaceProvider.js";
import { GcpWorkspaceProvider } from "../../workspace/provider/gcp/GcpWorkspaceProvider.js";

const appId = "12345678-1234-1234-1234-123456789abc";
const assignment = { workspaceId: appId, ownerUserId: "owner", runtime: { origin: "http://127.0.0.1:1", workspaceId: appId, token: "halo_app_token", generation: 1 }, sharedApp: { appId, extensionId: "books", syncAccess: "actions" as const } };

test("providers without sandboxed app VMs refuse app assignments instead of reusing the owner's VM", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/control-plane");
  await fs.mkdir(parent, { recursive: true });
  const appDataDir = await fs.mkdtemp(path.join(parent, "providers-"));
  const local = new LocalWorkspaceProvider({ appDataDir });
  expect(await local.ensure(assignment)).toBeInstanceOf(Error);
  // The development owner's runtime settings are untouched.
  await expect(fs.stat(path.join(appDataDir, workspaceRuntimeConfigFileName))).rejects.toThrow();
  expect(await local.ensure({ ...assignment, sharedApp: undefined })).toBeUndefined();
  const gcp = new GcpWorkspaceProvider({ projectId: "p", zone: "z", instanceTemplate: "t" });
  expect(await gcp.ensure(assignment)).toBeInstanceOf(Error);
  await fs.rm(appDataDir, { recursive: true, force: true });
});
