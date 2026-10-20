import { GoogleAuth } from "google-auth-library";
import { expect, test, vi } from "vitest";
import { readControlPlaneConfig } from "../controlPlane.js";

const configTest = test.extend<{
  read: () => ReturnType<typeof readControlPlaneConfig>;
  marketingSecret: { value: string; status: number };
}>({
  // oxlint-disable-next-line no-empty-pattern -- Native fixture signature.
  marketingSecret: async ({}, use) => {
    await use({ value: '["secret-admin"]', status: 200 });
  },
  read: async ({ marketingSecret }, use) => {
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
    vi.stubEnv("HALO_MARKETING_ADMIN_USER_IDS_SECRET_ID", undefined);
    vi.stubEnv("HALO_MARKETING_HOSTNAME", undefined);
    vi.stubEnv("HALO_MARKETING_HOMEPAGE_ORIGIN", undefined);
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const headers = vi
      .spyOn(GoogleAuth.prototype, "getRequestHeaders")
      .mockResolvedValue(new Headers());
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/secrets/test-marketing-admins/"))
          return Response.json(
            {
              payload: {
                data: Buffer.from(marketingSecret.value).toString("base64"),
              },
            },
            { status: marketingSecret.status },
          );
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

for (const cloud of [false, true]) {
  configTest(
    `marketing host and homepage overrides work in ${cloud ? "Cloud Run" : "development"}`,
    async ({ read }) => {
      vi.stubEnv("K_SERVICE", cloud ? "test" : undefined);
      vi.stubEnv("HALO_MARKETING_HOSTNAME", "go.gethalo.dev");
      vi.stubEnv("HALO_MARKETING_HOMEPAGE_ORIGIN", "https://gethalo.dev");
      const config = await read();
      if (config instanceof Error) throw config;
      expect(config.server).toMatchObject({
        marketingHostname: "go.gethalo.dev",
        marketingHomepageOrigin: "https://gethalo.dev",
      });
    },
  );
}
for (const [field, value] of [
  ["HALO_MARKETING_HOSTNAME", "https://go.gethalo.dev"],
  ["HALO_MARKETING_HOSTNAME", "go.gethalo.dev/path"],
  ["HALO_MARKETING_HOSTNAME", "go.gethalo.dev:443"],
  ["HALO_MARKETING_HOMEPAGE_ORIGIN", "http://gethalo.dev"],
  ["HALO_MARKETING_HOMEPAGE_ORIGIN", "https://gethalo.dev/path"],
  ["HALO_MARKETING_HOMEPAGE_ORIGIN", "https://user@gethalo.dev"],
  ["HALO_MARKETING_HOMEPAGE_ORIGIN", "https://gethalo.dev/?query=x"],
])
  configTest(
    `rejects malformed marketing override ${field}=${value}`,
    async ({ read }) => {
      vi.stubEnv(field, value);
      expect(await read()).toBeInstanceOf(Error);
    },
  );

for (const cloud of [false, true]) {
  configTest(
    `loads private administrator IDs from Secret Manager in ${cloud ? "Cloud Run" : "development"}`,
    async ({ read, marketingSecret }) => {
      vi.stubEnv("K_SERVICE", cloud ? "test" : undefined);
      vi.stubEnv(
        "HALO_MARKETING_ADMIN_USER_IDS_SECRET_ID",
        "test-marketing-admins",
      );
      vi.stubEnv(
        "HALO_MARKETING_ADMIN_USER_IDS",
        '["ignored-plaintext-admin"]',
      );
      const first = await read();
      if (first instanceof Error) throw first;
      expect(first.server.marketingAdminUserIds).toEqual(["secret-admin"]);
      marketingSecret.value = '["replacement-admin"]';
      const restarted = await read();
      if (restarted instanceof Error) throw restarted;
      expect(restarted.server.marketingAdminUserIds).toEqual([
        "replacement-admin",
      ]);
      marketingSecret.value = "[]";
      const revoked = await read();
      if (revoked instanceof Error) throw revoked;
      expect(revoked.server.marketingAdminUserIds).toEqual([]);
    },
  );
}
for (const status of [403, 404, 500]) {
  configTest(
    `fails closed when administrator secret returns HTTP ${status}`,
    async ({ read, marketingSecret }) => {
      vi.stubEnv(
        "HALO_MARKETING_ADMIN_USER_IDS_SECRET_ID",
        "test-marketing-admins",
      );
      vi.stubEnv("HALO_MARKETING_ADMIN_USER_IDS", '["must-not-be-used"]');
      marketingSecret.status = status;
      expect(await read()).toBeInstanceOf(Error);
    },
  );
}
for (const value of ["", "{", "{}", '["a","a"]', '[""]', "[1]"]) {
  configTest(
    `fails closed for invalid administrator secret ${value}`,
    async ({ read, marketingSecret }) => {
      vi.stubEnv(
        "HALO_MARKETING_ADMIN_USER_IDS_SECRET_ID",
        "test-marketing-admins",
      );
      marketingSecret.value = value;
      expect(await read()).toBeInstanceOf(Error);
    },
  );
}
