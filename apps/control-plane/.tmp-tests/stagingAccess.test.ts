import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ControlPlaneClient } from "@get-halo/shared/controlPlaneContract";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { afterEach, expect, test, vi } from "vitest";

const secrets = vi.hoisted(() => ({
  reads: [] as string[],
  value: "Tester@Example.com\n" as string | Error,
}));
vi.mock("@get-halo/config/controlPlane", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readControlPlaneSecret: async (secretId: string) => {
    secrets.reads.push(secretId);
    return secrets.value;
  },
}));

const { ControlPlane } = await import("../src/server/ControlPlane.js");

const testAuth = {
  secret: "test-control-plane-auth-secret-key!",
  googleClientId: "test-google-client-id.apps.googleusercontent.com",
  googleClientSecret: "test-google-client-secret",
};
const tmpRoot = resolve(import.meta.dirname, "../../../tmp/control-plane");
let dir: string;
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  secrets.reads.length = 0;
  secrets.value = "Tester@Example.com\n";
  vi.restoreAllMocks();
});

async function headersFor(origin: string, email: string) {
  using database = new DatabaseSync(join(dir, "control-plane.db"));
  const auth = betterAuth({ baseURL: origin, secret: testAuth.secret, database, plugins: [testUtils()] });
  const context = await auth.$context;
  const user = context.test.createUser({ email, name: email });
  await context.test.saveUser(user);
  return (await context.test.login({ userId: user.id })).headers;
}

async function startPlane(auth: { signInAllowlistSecretId?: string; stagingTestersSecretId?: string }) {
  await fs.mkdir(tmpRoot, { recursive: true });
  dir = await fs.mkdtemp(join(tmpRoot, "staging-access-"));
  await fs.mkdir(join(dir, "web"), { recursive: true });
  await fs.writeFile(join(dir, "web", "index.html"), "<html></html>");
  // SAFETY: these tests only read sessions, so no workspace is ever requested.
  const workspaceProvider = { getConnection: async () => undefined } as never;
  const plane = await ControlPlane.start({
    config: {
      deployment: "local",
      workspace: { deployment: "local" },
      appDataDir: dir,
      port: 0,
      auth: { ...testAuth, ...auth },
    },
    webRoot: join(dir, "web"),
    workspaceProvider,
  });
  if (plane instanceof Error) throw plane;
  return plane;
}

async function sessionFor(origin: string, email: string) {
  const headers = await headersFor(origin, email);
  // SAFETY: The control-plane origin serves controlPlaneContract at /rpc.
  const rpc = createORPCClient(new RPCLink({ origin, url: "/rpc", headers })) as ControlPlaneClient;
  const session = await rpc.auth.session();
  if (session.status !== "signed-in") throw new Error(`${email} is signed out`);
  return session.session;
}

test("production marks listed testers for the staging toggle without limiting sign-in", async () => {
  const plane = await startPlane({ stagingTestersSecretId: "halo-west-sign-in-allowlist" });
  expect((await sessionFor(plane.origin, "tester@example.com")).stagingAccess).toBe(true);
  // Anyone else still signs in; they just are not offered staging.
  expect((await sessionFor(plane.origin, "someone@example.com")).stagingAccess).toBe(false);
  expect(secrets.reads).toEqual(["halo-west-sign-in-allowlist"]);
  await plane.close();
});

test("without a staging testers secret nobody is offered staging", async () => {
  const plane = await startPlane({});
  expect((await sessionFor(plane.origin, "tester@example.com")).stagingAccess).toBe(false);
  expect(secrets.reads).toEqual([]);
  await plane.close();
});

test("an unreadable testers secret hides the toggle but keeps the session", async () => {
  secrets.value = new Error("secret unavailable");
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const plane = await startPlane({ stagingTestersSecretId: "halo-west-sign-in-allowlist" });
  expect((await sessionFor(plane.origin, "tester@example.com")).stagingAccess).toBe(false);
  expect(logged).toHaveBeenCalled();
  await plane.close();
});
