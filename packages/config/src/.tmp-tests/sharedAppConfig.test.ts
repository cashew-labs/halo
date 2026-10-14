import { expect, test } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { workspaceServerConfigSchema } from "../workspaceServer.js";

test("host configuration accepts an app role and rejects malformed sandbox settings", () => {
  const config = { environment: "cloud", workspaceRoot: "/workspace", appDataDir: "/state", appVersion: "test", ownerUserId: "owner", logFilePath: "/log", corsOrigins: [], port: 8788, sharedApp: { appId: "12345678-1234-1234-1234-123456789abc", extensionId: "books", syncAccess: "actions" }, extensionRuntime: { executable: "/usr/bin/node", electronRunAsNode: false, sandbox: { socketPath: "/run/halo-apps/control.sock" } } };
  expect(Value.Check(workspaceServerConfigSchema, config)).toBe(true);
  expect(Value.Check(workspaceServerConfigSchema, { ...config, sharedApp: { ...config.sharedApp, extensionId: "../other" } })).toBe(false);
});
