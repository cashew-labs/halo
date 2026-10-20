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
  "reads complete cloud custom-domain configuration",
  async ({ read }) => {
    const config = await read();
    expect(config).not.toBeInstanceOf(Error);
    if (config instanceof Error) throw config;
    expect(config.server).toMatchObject({
      customDomains: {
        projectId: "halo-relay",
        certificateMap: "halo-prod",
        address: "192.0.2.1",
      },
    });
  },
);
configTest(
  "leaves custom domains disabled when the map is absent",
  async ({ read }) => {
    vi.stubEnv("APP_DOMAIN_CERTIFICATE_MAP", undefined);
    const config = await read();
    if (config instanceof Error) throw config;
    expect(config.server).not.toHaveProperty(
      "customDomains",
      expect.anything(),
    );
  },
);
for (const { name, value } of [
  { name: "APP_DOMAIN_PROJECT_ID", value: undefined },
  { name: "APP_DOMAIN_PROJECT_ID", value: "../../other-project" },
  { name: "APP_DOMAIN_ADDRESS", value: "not-an-ip" },
  { name: "APP_DOMAIN_CERTIFICATE_MAP", value: "../other-map" },
])
  configTest(
    `rejects incomplete or unsafe ${name}: ${value ?? "missing"}`,
    async ({ read }) => {
      vi.stubEnv(name, value);
      expect(await read()).toBeInstanceOf(Error);
    },
  );
