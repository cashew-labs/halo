import { afterEach, beforeEach, expect, test, vi } from "vitest";

const reads = vi.hoisted(() => [] as { projectId: string; secretId: string }[]);
vi.mock("../src/readGcpSecret.js", () => ({
  readGcpSecret: async (ctx: { projectId: string; secretId: string }) => {
    reads.push(ctx);
    return ctx.secretId === "halo-control-plane-integration-credential-key"
      ? Buffer.alloc(32, 1).toString("base64")
      : `value-of-${ctx.secretId}-padded-to-thirty-two-characters`;
  },
}));

const env = {
  K_SERVICE: "halo-west-control-plane",
  PORT: "8080",
  BETTER_AUTH_URL: "https://staging.gethalo.dev",
  DATABASE_URL_SECRET_ID: "db",
  BETTER_AUTH_SECRET_ID: "auth",
  GOOGLE_CLIENT_ID_SECRET_ID: "client-id",
  GOOGLE_CLIENT_SECRET_ID: "client-secret",
  TRACE_BUCKET: "traces",
  WORKSPACE_SERVICE_ACCOUNT: "ws@example.com",
  WORKSPACE_PROVIDER: "gcp",
  WORKSPACE_PROJECT_ID: "halo-relay",
  WORKSPACE_ZONE: "us-west2-a",
  WORKSPACE_INSTANCE_TEMPLATE: "template",
};

let argv: string[];
beforeEach(() => {
  reads.length = 0;
  argv = process.argv;
  process.argv = [argv[0]!, argv[1]!];
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
});
afterEach(() => {
  process.argv = argv;
  vi.unstubAllEnvs();
});

test("SIGN_IN_ALLOWLIST_SECRET_ID reaches the Cloud Run auth config", async () => {
  vi.stubEnv("SIGN_IN_ALLOWLIST_SECRET_ID", "halo-west-sign-in-allowlist");
  const { readControlPlaneConfig } = await import("../src/controlPlane.js");
  const config = await readControlPlaneConfig();
  if (config instanceof Error) throw config;
  expect(config.server.auth.signInAllowlistSecretId).toBe("halo-west-sign-in-allowlist");
});

test("without the variable the allowlist is unset", async () => {
  const { readControlPlaneConfig } = await import("../src/controlPlane.js");
  const config = await readControlPlaneConfig();
  if (config instanceof Error) throw config;
  expect(config.server.auth.signInAllowlistSecretId).toBeUndefined();
});

test("readControlPlaneSecret reads from the halo-relay project", async () => {
  const { readControlPlaneSecret } = await import("../src/controlPlane.js");
  expect(await readControlPlaneSecret("halo-west-sign-in-allowlist")).toContain(
    "value-of-halo-west-sign-in-allowlist",
  );
  expect(reads).toEqual([{ projectId: "halo-relay", secretId: "halo-west-sign-in-allowlist" }]);
});
