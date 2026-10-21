import { test, expect, vi } from "vitest";
import * as errore from "errore";
import http from "node:http";
import events from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { readControlPlaneConfig } from "@get-halo/config/controlPlane";

const configTest = test.extend<{ secrets: Map<string, string | Error> }>({
  secrets: async ({}, use) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const root = path.resolve("tmp/github-integration/config-test");
    await fs.mkdir(root, { recursive: true });
    const metadata = http.createServer((request, response) => {
      response.setHeader("Metadata-Flavor", "Google");
      if (request.url?.includes("/token"))
        response.setHeader("content-type", "application/json").end(
          JSON.stringify({
            access_token: "fixture-gcp-token",
            expires_in: 3600,
            token_type: "Bearer",
          }),
        );
      else response.end("halo-relay");
    });
    metadata.listen(0, "127.0.0.1");
    await events.once(metadata, "listening");
    // SAFETY: The numeric listener is ready before its address is read.
    const address = metadata.address() as AddressInfo;
    const args = process.argv;
    process.argv = [process.execPath, "config-test"];
    vi.stubEnv("CLOUDSDK_CONFIG", root);
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", undefined);
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "halo-relay");
    vi.stubEnv("GCE_METADATA_HOST", `127.0.0.1:${address.port}`);
    vi.stubEnv("GCE_METADATA_IP", `127.0.0.1:${address.port}`);
    vi.stubEnv("K_SERVICE", undefined);
    vi.stubEnv("HALO_ENVIRONMENT", "development");
    vi.stubEnv("GITHUB_CLIENT_ID_SECRET_ID", undefined);
    vi.stubEnv("GITHUB_CLIENT_SECRET_ID", undefined);
    const secrets = new Map<string, string | Error>([
      [
        "halo-dev-local-better-auth-secret",
        "fixture-auth-secret-with-at-least-32-characters",
      ],
      ["halo-west-control-plane-google-client-id", "fixture-google-client-id"],
      [
        "halo-west-control-plane-google-client-secret",
        "fixture-google-client-secret",
      ],
      ["together-ai-api-key", "fixture-inference-key"],
      [
        "halo-control-plane-integration-credential-key",
        Buffer.alloc(32, 1).toString("base64"),
      ],
      ["github-client-id", "  github-app-client-id\n"],
      ["github-client-secret", "  github-app-client-secret\n"],
      ["database", "postgres://fixture"],
    ]);
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe("https://secretmanager.googleapis.com");
      const secretId = decodeURIComponent(
        url.pathname.split("/secrets/")[1]!.split("/")[0]!,
      );
      const value = secrets.get(secretId);
      if (value === undefined || value instanceof Error)
        return new Response("unavailable", { status: 503 });
      return Response.json({
        payload: { data: Buffer.from(value).toString("base64") },
      });
    });
    cleanup.defer(async () => {
      process.argv = args;
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      metadata.closeAllConnections();
      await new Promise<void>((resolve) => metadata.close(() => resolve()));
    });
    await use(secrets);
  },
});

configTest(
  "leaves GitHub unconfigured when neither secret name is set",
  async ({ secrets }) => {
    void secrets;
    const config = await readControlPlaneConfig();
    if (config instanceof Error) throw config;
    expect(config.server.github).toBeUndefined();
  },
);
for (const variable of [
  "GITHUB_CLIENT_ID_SECRET_ID",
  "GITHUB_CLIENT_SECRET_ID",
]) {
  configTest(
    `rejects partial GitHub configuration: ${variable}`,
    async ({ secrets }) => {
      void secrets;
      vi.stubEnv(variable, "github-client-id");
      expect(await readControlPlaneConfig()).toMatchObject({
        _tag: "ControlPlaneConfigError",
        detail: expect.stringContaining(
          "set both GITHUB_CLIENT_ID_SECRET_ID and GITHUB_CLIENT_SECRET_ID",
        ),
      });
    },
  );
}
for (const deployment of ["development", "cloudRun"]) {
  configTest(
    `loads and trims GitHub credentials for ${deployment}`,
    async ({ secrets }) => {
      void secrets;
      vi.stubEnv("GITHUB_CLIENT_ID_SECRET_ID", "github-client-id");
      vi.stubEnv("GITHUB_CLIENT_SECRET_ID", "github-client-secret");
      if (deployment === "cloudRun") {
        for (const [name, value] of Object.entries({
          K_SERVICE: "fixture",
          PORT: "8787",
          BETTER_AUTH_URL: "https://halo.test",
          DATABASE_URL_SECRET_ID: "database",
          BETTER_AUTH_SECRET_ID: "halo-dev-local-better-auth-secret",
          GOOGLE_CLIENT_ID_SECRET_ID:
            "halo-west-control-plane-google-client-id",
          GOOGLE_CLIENT_SECRET_ID:
            "halo-west-control-plane-google-client-secret",
          WORKSPACE_PROJECT_ID: "halo-relay",
          WORKSPACE_ZONE: "test-zone",
          WORKSPACE_INSTANCE_TEMPLATE: "test-template",
          TRACE_BUCKET: "test-traces",
          WORKSPACE_SERVICE_ACCOUNT: "test@halo.test",
        }))
          vi.stubEnv(name, value);
      }
      const config = await readControlPlaneConfig();
      if (config instanceof Error) throw config;
      expect(config.server.github).toEqual({
        clientId: "github-app-client-id",
        clientSecret: "github-app-client-secret",
      });
    },
  );
}
for (const secretId of ["github-client-id", "github-client-secret"]) {
  configTest(`propagates a failed ${secretId} read`, async ({ secrets }) => {
    vi.stubEnv("GITHUB_CLIENT_ID_SECRET_ID", "github-client-id");
    vi.stubEnv("GITHUB_CLIENT_SECRET_ID", "github-client-secret");
    secrets.set(secretId, new Error("fixture failure"));
    expect(await readControlPlaneConfig()).toMatchObject({
      _tag: "ReadGcpSecretError",
      secretId,
    });
  });
}
