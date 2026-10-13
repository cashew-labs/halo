import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    getPath: () => "/unused",
    setPath: () => undefined,
    getAppPath: () => "/unused",
  },
}));
vi.mock("electron", () => electron);

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "electron-config-"));
  vi.stubEnv("HALO_USER_DATA", dataDir);
  vi.stubEnv("HALO_E2E", "");
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function loadConfig(ctx: { packaged: boolean; channel?: string }) {
  electron.app.isPackaged = ctx.packaged;
  if (ctx.channel !== undefined)
    fs.writeFileSync(path.join(dataDir, "release-channel"), ctx.channel);
  const { config } = await import("../src/electron.js");
  if (config instanceof Error) throw config;
  return config;
}

test("packaged builds default to production", async () => {
  const config = await loadConfig({ packaged: true });
  expect(config.releaseChannel).toBe("production");
  expect(config.controlPlaneOrigin).toBe("https://gethalo.dev");
  expect(config.controlPlaneSessionPath).toBe(
    path.join(dataDir, "control-plane-session"),
  );
  expect(config.updates).toEqual({
    enabled: true,
    repository: "cashew-labs/halo",
  });
  expect(config.releaseChannelError).toBeUndefined();
});

test("a staging file sends packaged builds to staging", async () => {
  const config = await loadConfig({ packaged: true, channel: "staging\n" });
  expect(config.releaseChannel).toBe("staging");
  expect(config.controlPlaneOrigin).toBe("https://staging.gethalo.dev");
  expect(config.controlPlaneSessionPath).toBe(
    path.join(dataDir, "staging-control-plane-session"),
  );
  expect(config.updates).toEqual({
    enabled: true,
    repository: "cashew-labs/halo-staging",
  });
});

test("development ignores the channel for its origin and updates", async () => {
  const config = await loadConfig({ packaged: false, channel: "staging" });
  expect(config.controlPlaneOrigin).toBe("http://127.0.0.1:8787");
  expect(config.updates.enabled).toBe(false);
});

test("an invalid channel falls back to production and reports why", async () => {
  const config = await loadConfig({ packaged: true, channel: "beta" });
  expect(config.releaseChannel).toBe("production");
  expect(config.controlPlaneOrigin).toBe("https://gethalo.dev");
  expect(config.releaseChannelError?.message).toContain('"beta"');
});

test("an unreadable channel falls back to production", async () => {
  fs.mkdirSync(path.join(dataDir, "release-channel"));
  const config = await loadConfig({ packaged: true });
  expect(config.releaseChannel).toBe("production");
  expect(config.releaseChannelError).toBeInstanceOf(Error);
});
