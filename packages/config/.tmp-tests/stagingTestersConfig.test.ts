import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../src/readGcpSecret.js", () => ({
  readGcpSecret: async (ctx: { projectId: string; secretId: string }) =>
    ctx.secretId === "halo-control-plane-integration-credential-key"
      ? Buffer.alloc(32, 1).toString("base64")
      : `value-of-${ctx.secretId}-padded-to-thirty-two-characters`,
}));

const env = {
  K_SERVICE: "halo-prod-control-plane",
  PORT: "8080",
  BETTER_AUTH_URL: "https://gethalo.dev",
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
  argv = process.argv;
  process.argv = [argv[0]!, argv[1]!];
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
});
afterEach(() => {
  process.argv = argv;
  vi.unstubAllEnvs();
});

test("STAGING_TESTERS_SECRET_ID reaches the Cloud Run auth config without an allowlist", async () => {
  vi.stubEnv("STAGING_TESTERS_SECRET_ID", "halo-west-sign-in-allowlist");
  const { readControlPlaneConfig } = await import("../src/controlPlane.js");
  const config = await readControlPlaneConfig();
  if (config instanceof Error) throw config;
  expect(config.server.auth.stagingTestersSecretId).toBe("halo-west-sign-in-allowlist");
  expect(config.server.auth.signInAllowlistSecretId).toBeUndefined();
});

test("without the variable no staging testers are configured", async () => {
  const { readControlPlaneConfig } = await import("../src/controlPlane.js");
  const config = await readControlPlaneConfig();
  if (config instanceof Error) throw config;
  expect(config.server.auth.stagingTestersSecretId).toBeUndefined();
});
