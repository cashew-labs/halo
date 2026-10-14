import fs from "node:fs/promises";
import path from "node:path";
import childProcess from "node:child_process";
import util from "node:util";
import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { ExeWorkspaceProvider } from "../ExeWorkspaceProvider.js";
import type { WorkspaceProviderAssignment } from "../../WorkspaceProviderApi.js";

const providerTest = test.extend<{ provider: ExeWorkspaceProvider; assignments: WorkspaceProviderAssignment[] }>({
  assignments: [],
  provider: async ({ assignments }, use) => {
    const root = path.resolve(import.meta.dirname, "../../../../../../../tmp/extension-sharing");
    await fs.mkdir(root, { recursive: true });
    const directory = await fs.mkdtemp(path.join(root, "exe-"));
    const key = path.join(directory, "id_ed25519");
    await util.promisify(childProcess.execFile)("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    let exists = false;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url) !== "https://exe.dev/exec") throw new Error("Unexpected external request");
      const command = init?.body?.toString() ?? "";
      if (command.startsWith("'ls'")) {
        const vmName = command.match(/'ls' '([^']+)'/)![1];
        return new Response(JSON.stringify({ vms: exists ? [{ vm_name: vmName, status: "running", proxy_share: "private" }] : [] }));
      }
      if (command.startsWith("'cp'")) { exists = true; return new Response(JSON.stringify({ name: command.match(/'cp' '[^']+' '([^']+)'/)![1] })); }
      if (command.startsWith("'ssh'")) {
        const encoded = command.match(/halo-workspace-assign ([a-zA-Z0-9_-]+)/)![1]!;
        assignments.push(JSON.parse(Buffer.from(encoded, "base64url").toString()));
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        return new Response("HALO_WORKSPACE_ASSIGNED");
      }
      throw new Error("Unexpected Exe operation: " + command);
    });
    await use(new ExeWorkspaceProvider({ privateKeyPath: key, templateVmName: "halo-template", gatewaySecret: "gateway-secret-longer-than-32-characters" }));
    fetch.mockRestore();
    await fs.rm(directory, { recursive: true });
  },
});

providerTest("app VM assignments preserve app identity and do not coalesce changed app permissions", async ({ provider, assignments }) => {
  const appId = randomUUID();
  const input: WorkspaceProviderAssignment = { workspaceId: appId, ownerUserId: "owner", runtime: { workspaceId: appId, origin: "https://gethalo.dev", token: "app-runtime-token-longer-than-32-characters", generation: 1 }, sharedApp: { appId, extensionId: "books", syncAccess: "read-only" } };
  const first = provider.ensure(input);
  const second = provider.ensure({ ...input, sharedApp: { ...input.sharedApp!, syncAccess: "actions" } });
  expect(await first).toBeUndefined(); expect(await second).toBeUndefined();
  expect(assignments.map((item) => item.sharedApp?.syncAccess)).toEqual(["read-only", "actions"]);
  expect(assignments.every((item) => item.sharedApp?.appId === item.workspaceId && item.runtime.workspaceId === item.workspaceId)).toBe(true);
  expect(await provider.ensure({ ...input, workspaceId: randomUUID() })).toBeInstanceOf(Error);
});
