import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    decryptStringAsync: async (encrypted: Buffer) => ({
      result: encrypted.toString("utf8"),
      shouldReEncrypt: false,
    }),
  },
  shell: { openExternal: vi.fn() },
}));

const { ControlPlaneAuth } = await import("../src/main/auth/ControlPlaneAuth.js");

let dataDir: string;
let authorizations: (string | null)[];

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-auth-"));
  authorizations = [];
  vi.stubGlobal("fetch", async (request: Request | string, init?: RequestInit) => {
    const headers = new Headers(
      request instanceof Request ? request.headers : init?.headers,
    );
    authorizations.push(headers.get("authorization"));
    throw new Error("offline");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("start reads the session saved at sessionPath, not the default file", async () => {
  fs.writeFileSync(path.join(dataDir, "control-plane-session"), "production-token");
  const sessionPath = path.join(dataDir, "staging-control-plane-session");
  fs.writeFileSync(sessionPath, "staging-token");

  const auth = await ControlPlaneAuth.start({
    origin: "https://staging.gethalo.dev",
    sessionPath,
  });
  await auth.getWorkspaceStatus();

  expect(authorizations).toEqual(["Bearer staging-token"]);
});

test("a channel without a saved session starts signed out", async () => {
  fs.writeFileSync(path.join(dataDir, "control-plane-session"), "production-token");

  const auth = await ControlPlaneAuth.start({
    origin: "https://staging.gethalo.dev",
    sessionPath: path.join(dataDir, "staging-control-plane-session"),
  });

  expect(await auth.getWorkspaceStatus()).toBeUndefined();
  expect(authorizations).toEqual([]);
});
