import { Value } from "@sinclair/typebox/value";
import { expect, test } from "vitest";
import { controlPlaneConfigSchema } from "../controlPlane.js";

const config = {
  deployment: "local",
  appDataDir: "tmp/test",
  port: 0,
  auth: {
    secret: "test-secret-that-is-at-least-32-characters",
    googleClientId: "test",
    googleClientSecret: "test",
  },
  workspace: { deployment: "local" },
};

const cloudConfig = {
  ...config,
  deployment: "cloudRun",
  origin: "https://gethalo.dev",
  databaseUrl: "postgres://test",
  traceBucket: "test",
  workspaceServiceAccount: "test@example.com",
  workspace: {
    deployment: "gcp",
    instanceTemplate: "test",
    projectId: "test",
    zone: "test",
  },
};

test.each([undefined, "G-ABC123", "G-87KZ9JXCVX"])(
  "accepts an absent or valid analytics ID: %s",
  (googleAnalyticsMeasurementId) => {
    for (const server of [config, cloudConfig]) {
      expect(
        Value.Check(controlPlaneConfigSchema, {
          ...server,
          googleAnalyticsMeasurementId,
        }),
      ).toBe(true);
    }
  },
);
test.each(["", "G-invalid", 'G-x" /><script>', "<script>alert(1)</script>"])(
  "rejects invalid analytics IDs before they reach HTML: %s",
  (googleAnalyticsMeasurementId) => {
    for (const server of [config, cloudConfig]) {
      expect(
        Value.Check(controlPlaneConfigSchema, {
          ...server,
          googleAnalyticsMeasurementId,
        }),
      ).toBe(false);
    }
  },
);
