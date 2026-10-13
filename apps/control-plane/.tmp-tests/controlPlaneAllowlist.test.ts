import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { afterEach, expect, test, vi } from "vitest";

const secrets = vi.hoisted(() => ({ reads: [] as string[], value: "allowed@example.com" }));
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
});

async function headersFor(origin: string, email: string) {
  // Existing sessions: created directly, as they would exist before the allowlist.
  using database = new DatabaseSync(join(dir, "control-plane.db"));
  const auth = betterAuth({ baseURL: origin, secret: testAuth.secret, database, plugins: [testUtils()] });
  const context = await auth.$context;
  const user = context.test.createUser({ email, name: email });
  await context.test.saveUser(user);
  return (await context.test.login({ userId: user.id })).headers;
}

async function startPlane(signInAllowlistSecretId?: string) {
  await fs.mkdir(tmpRoot, { recursive: true });
  dir = await fs.mkdtemp(join(tmpRoot, "allowlist-plane-"));
  await fs.mkdir(join(dir, "web"), { recursive: true });
  await fs.writeFile(join(dir, "web", "index.html"), "<html></html>");
  // SAFETY: past the session check, the proxy only asks for a connection, and
  // reporting none ends the request without a workspace.
  const workspaceProvider = { getConnection: async () => undefined } as never;
  const plane = await ControlPlane.start({
    config: {
      deployment: "local",
      workspace: { deployment: "local" },
      appDataDir: dir,
      port: 0,
      auth: { ...testAuth, signInAllowlistSecretId },
    },
    webRoot: join(dir, "web"),
    workspaceProvider,
  });
  if (plane instanceof Error) throw plane;
  return plane;
}

test("a control plane with an allowlist secret refuses sessions for emails not on it", async () => {
  secrets.reads.length = 0;
  const plane = await startPlane("test-allowlist");
  const outsider = await headersFor(plane.origin, "outsider@example.com");
  const response = await fetch(`${plane.origin}/workspace/health`, { headers: outsider });
  expect(response.status).toBe(401);
  expect(secrets.reads).toEqual(["test-allowlist"]);
  await plane.close();
});

test("without an allowlist secret, sessions are not checked against a list", async () => {
  secrets.reads.length = 0;
  const plane = await startPlane(undefined);
  const user = await headersFor(plane.origin, "outsider@example.com");
  const response = await fetch(`${plane.origin}/workspace/health`, { headers: user });
  expect(response.status).not.toBe(401);
  expect(secrets.reads).toEqual([]);
  await plane.close();
});
