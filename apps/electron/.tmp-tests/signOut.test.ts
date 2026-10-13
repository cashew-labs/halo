import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { AuthenticationRequiredError } from "@get-halo/client";
import * as errore from "errore";
import { afterEach, expect, test, vi } from "vitest";

// The saved session is "encrypted" as plain UTF-8 so tests can seed it.
vi.mock("electron", () => ({
  app: {},
  shell: {},
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value: string) => Buffer.from(value),
    decryptStringAsync: async (value: Buffer) => ({
      result: value.toString(),
      shouldReEncrypt: false,
    }),
  },
}));

// The package entry also loads tandem-core, whose extensionless ESM imports
// Node cannot resolve outside its own vitest config; reuse the leaf modules.
vi.mock("@get-halo/client", async () => ({
  ...(await import("../../../packages/client/src/protocol.js")),
  ...(await import("../../../packages/client/src/connectionErrors.js")),
}));

const { ControlPlaneAuth } =
  await import("../src/main/auth/ControlPlaneAuth.js");
const { createLocalDesktopAuthentication } =
  await import("../src/main/DesktopAuthentication.js");

const tmpRoot = path.resolve(
  import.meta.dirname,
  "../../../tmp/staging-indicator/unit",
);

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup(ctx: { status: number; token?: string }) {
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(tmpRoot, "sign-out-"));
  const sessionPath = path.join(dir, "control-plane-session");
  if (ctx.token !== undefined) await fs.writeFile(sessionPath, ctx.token);
  const requests: { method?: string; url?: string; authorization?: string }[] =
    [];
  const server = http.createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    });
    response.writeHead(ctx.status).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = await ControlPlaneAuth.start({ origin, sessionPath });
  const cleanup = new errore.AsyncDisposableStack();
  cleanup.defer(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { auth, sessionPath, requests, server, cleanup };
}

test("revokes the bearer session and removes the saved token", async () => {
  const ctx = await setup({ status: 200, token: "token-123" });
  await using _cleanup = ctx.cleanup;
  expect(await ctx.auth.signOut()).toBeUndefined();
  expect(ctx.requests).toEqual([
    {
      method: "POST",
      url: "/api/auth/sign-out",
      authorization: "Bearer token-123",
    },
  ]);
  await expect(fs.access(ctx.sessionPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await ctx.auth.getSession()).toBeUndefined();
  expect(await ctx.auth.getWorkspaceConnection()).toBeInstanceOf(
    AuthenticationRequiredError,
  );
});

test("signs out locally and logs when the control plane rejects revocation", async () => {
  const ctx = await setup({ status: 500, token: "token-123" });
  await using _cleanup = ctx.cleanup;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await ctx.auth.signOut()).toBeUndefined();
  expect(warn).toHaveBeenCalledOnce();
  expect(String(warn.mock.calls[0]?.[0])).toContain(
    "revoke the session (HTTP 500)",
  );
  await expect(fs.access(ctx.sessionPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("signs out locally and logs when the control plane is unreachable", async () => {
  const ctx = await setup({ status: 200, token: "token-123" });
  await using _cleanup = ctx.cleanup;
  ctx.server.closeAllConnections();
  await new Promise((resolve) => ctx.server.close(resolve));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(await ctx.auth.signOut()).toBeUndefined();
  expect(warn).toHaveBeenCalledOnce();
  expect(String(warn.mock.calls[0]?.[0])).toContain("revoke the session");
  await expect(fs.access(ctx.sessionPath)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("returns the error and stays signed in when the saved token cannot be removed", async () => {
  const ctx = await setup({ status: 200, token: "token-123" });
  await using _cleanup = ctx.cleanup;
  // A non-empty directory in place of the session file makes removal fail.
  await fs.rm(ctx.sessionPath);
  await fs.mkdir(path.join(ctx.sessionPath, "blocker"), { recursive: true });
  const result = await ctx.auth.signOut();
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toContain("remove the saved session");
  // The token is kept, so a second attempt still revokes it.
  await fs.rm(ctx.sessionPath, { recursive: true });
  expect(await ctx.auth.signOut()).toBeUndefined();
  expect(ctx.requests.map((request) => request.authorization)).toEqual([
    "Bearer token-123",
    "Bearer token-123",
  ]);
});

test("does nothing without a saved session", async () => {
  const ctx = await setup({ status: 200 });
  await using _cleanup = ctx.cleanup;
  expect(await ctx.auth.signOut()).toBeUndefined();
  expect(ctx.requests).toEqual([]);
});

test("a local identity is hidden after sign out until the next sign-in", async () => {
  const session = {
    session: { id: "s", userId: "u", expiresAt: "2100-01-01T00:00:00.000Z" },
    user: { id: "u", email: "u@example.com", name: "U" },
  };
  const failure = new Error("no ADC");
  let fail = false;
  const auth = createLocalDesktopAuthentication({
    dataDir: tmpRoot,
    identity: {
      getSession: async () => session,
      signIn: async () => (fail ? failure : session),
    },
  });
  expect(await auth.getSession()).toBe(session);
  expect(await auth.signOut()).toBeUndefined();
  expect(await auth.getSession()).toBeUndefined();
  fail = true;
  expect(await auth.signIn()).toBe(failure);
  expect(await auth.getSession()).toBeUndefined();
  fail = false;
  expect(await auth.signIn()).toBe(session);
  expect(await auth.getSession()).toBe(session);
});
