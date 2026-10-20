import { GoogleAuth } from "google-auth-library";
import { expect, test, vi } from "vitest";
import { readControlPlaneConfig } from "../controlPlane.js";

const configTest = test.extend<{
  read: () => ReturnType<typeof readControlPlaneConfig>;
}>({
  // oxlint-disable-next-line no-empty-pattern -- Native fixture signature.
  read: async ({}, use) => {
    const argv = process.argv;
    process.argv = argv.slice(0, 2);
    const env = {
      K_SERVICE: "test",
      PORT: "8080",
      BETTER_AUTH_URL: "https://gethalo.dev",
      DATABASE_URL_SECRET_ID: "database",
      BETTER_AUTH_SECRET_ID: "auth",
      GOOGLE_CLIENT_ID_SECRET_ID: "client",
      GOOGLE_CLIENT_SECRET_ID: "client-secret",
      WORKSPACE_PROVIDER: "gcp",
      WORKSPACE_PROJECT_ID: "halo-relay",
      WORKSPACE_ZONE: "us-west1-a",
      WORKSPACE_INSTANCE_TEMPLATE: "template",
      WORKSPACE_SERVICE_ACCOUNT: "workspace@example.org",
      TRACE_BUCKET: "traces",
      APP_DOMAIN_PROJECT_ID: "halo-relay",
      APP_DOMAIN_CERTIFICATE_MAP: "halo-prod",
      APP_DOMAIN_ADDRESS: "192.0.2.1",
    };
    vi.stubEnv("HALO_MARKETING_ADMIN_USER_IDS", undefined);
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const headers = vi
      .spyOn(GoogleAuth.prototype, "getRequestHeaders")
      .mockResolvedValue(new Headers());
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        const secret = url.includes("integration-credential-key")
          ? Buffer.alloc(32, 17).toString("base64")
          : "test-control-plane-auth-secret-long-enough";
        return Response.json({
          payload: { data: Buffer.from(secret).toString("base64") },
        });
      });
    try {
      await use(readControlPlaneConfig);
    } finally {
      headers.mockRestore();
      fetch.mockRestore();
      vi.unstubAllEnvs();
      process.argv = argv;
    }
  },
});

configTest(
  "denies management by default and reads explicit administrator IDs",
  async ({ read }) => {
    const without = await read();
    if (without instanceof Error) throw without;
    expect(without.server.marketingAdminUserIds).toEqual([]);
    vi.stubEnv("HALO_MARKETING_ADMIN_USER_IDS", '["halo-admin"]');
    const configured = await read();
    if (configured instanceof Error) throw configured;
    expect(configured.server.marketingAdminUserIds).toEqual(["halo-admin"]);
  },
);
for (const value of ["{", "{}", '["a","a"]', '[""]', "[1]"])
  configTest(
    `rejects invalid administrator configuration ${value}`,
    async ({ read }) => {
      vi.stubEnv("HALO_MARKETING_ADMIN_USER_IDS", value);
      expect(await read()).toBeInstanceOf(Error);
    },
  );
configTest(
  "reads administrator IDs for the development server too",
  async ({ read }) => {
    vi.stubEnv("K_SERVICE", undefined);
    vi.stubEnv("HALO_MARKETING_ADMIN_USER_IDS", '["dev-admin"]');
    const config = await read();
    if (config instanceof Error) throw config;
    expect(config.server.marketingAdminUserIds).toEqual(["dev-admin"]);
    vi.stubEnv("HALO_MARKETING_ADMIN_USER_IDS", "{}");
    expect(await read()).toBeInstanceOf(Error);
  },
);
