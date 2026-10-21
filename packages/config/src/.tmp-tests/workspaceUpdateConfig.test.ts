import { expect, test, vi } from "vitest";
import { GoogleAuth } from "google-auth-library";
import { readControlPlaneConfig } from "../controlPlane.js";

test.each(["pinned", "tag", "missing-reader", "absent"])(
  "control plane tolerates optional updater configuration: %s",
  async (mode) => {
    const originalArgv = process.argv;
    process.argv = process.argv.slice(0, 2);
    const values = {
      K_SERVICE: "test-plane",
      PORT: "8787",
      BETTER_AUTH_URL: "https://halo.example",
      DATABASE_URL_SECRET_ID: "database",
      BETTER_AUTH_SECRET_ID: "auth",
      GOOGLE_CLIENT_ID_SECRET_ID: "client-id",
      GOOGLE_CLIENT_SECRET_ID: "client-secret",
      WORKSPACE_PROVIDER: "exe",
      EXE_GATEWAY_SECRET_ID: "gateway",
      EXE_TEMPLATE_VM_NAME: "test-template",
      EXE_PRIVATE_KEY_PATH: "/test/key",
      TRACE_BUCKET: "test-bucket",
      WORKSPACE_SERVICE_ACCOUNT: "test@example.com",
      WORKSPACE_UPDATE_IMAGE:
        mode === "absent"
          ? undefined
          : mode === "tag"
            ? "registry.example/halo:v1"
            : `registry.example/halo@sha256:${"a".repeat(64)}`,
      WORKSPACE_UPDATE_IMAGE_PULLER:
        mode === "missing-reader" ? undefined : "reader@example.com",
    };
    for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
    const credentials = vi
      .spyOn(GoogleAuth.prototype, "getRequestHeaders")
      .mockResolvedValue(
        new Headers({ authorization: "Bearer external-test-identity" }),
      );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", async (url: string) => {
      expect(String(url)).toContain("secretmanager.googleapis.com");
      const name = decodeURIComponent(new URL(url).pathname.split("/")[5]!);
      const secret =
        name === "halo-control-plane-integration-credential-key"
          ? Buffer.alloc(32, 1).toString("base64")
          : name === "auth" || name === "gateway"
            ? "test-secret-value-that-has-at-least-32-bytes"
            : "fixture-value";
      return Response.json({
        payload: { data: Buffer.from(secret).toString("base64") },
      });
    });
    try {
      const config = await readControlPlaneConfig();
      if (config instanceof Error) throw config;
      if (mode === "pinned")
        expect(config.server.workspaceUpdates?.image).toContain("@sha256:");
      else expect(config.server.workspaceUpdates).toBeUndefined();
      expect(warning.mock.calls.length).toBe(
        mode === "tag" || mode === "missing-reader" ? 1 : 0,
      );
    } finally {
      process.argv = originalArgv;
      credentials.mockRestore();
      warning.mockRestore();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  },
);
