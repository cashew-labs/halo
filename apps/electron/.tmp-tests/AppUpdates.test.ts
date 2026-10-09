import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateElectronApp: vi.fn(),
  macUpdaterOptions: [] as { feedUrl: string }[],
}));

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.1.67",
    getPath: () => "/Users/test",
  },
  autoUpdater: { on: vi.fn() },
  dialog: {},
}));
vi.mock("update-electron-app", () => ({
  updateElectronApp: mocks.updateElectronApp,
  UpdateSourceType: { ElectronPublicUpdateService: 1, StaticStorage: 2 },
}));
vi.mock("../src/main/app/MacAppUpdater.js", () => ({
  MacAppUpdater: class {
    constructor(options: { feedUrl: string }) {
      mocks.macUpdaterOptions.push(options);
    }
    start() {}
    close() {}
  },
}));

const { AppUpdates } = await import("../src/main/app/AppUpdates.js");

function startUpdates(platform: NodeJS.Platform, repository: string) {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  const updates = new AppUpdates({
    config: { enabled: true, repository },
    getWindow: () => undefined,
    // SAFETY: AppUpdates only logs on failure paths not exercised here.
    logger: {} as never,
    onInstallCancelled: () => undefined,
  });
  updates.start();
  return updates;
}

beforeEach(() => {
  mocks.updateElectronApp.mockReset();
  mocks.macUpdaterOptions.length = 0;
  vi.restoreAllMocks();
});

test("macOS polls the configured repository's feed", () => {
  startUpdates("darwin", "cashew-labs/halo-staging");
  expect(mocks.macUpdaterOptions[0]?.feedUrl).toBe(
    `https://update.electronjs.org/cashew-labs/halo-staging/darwin-${process.arch}/0.1.67`,
  );
});

test("Windows updates from the configured repository", () => {
  startUpdates("win32", "cashew-labs/halo");
  expect(mocks.updateElectronApp).toHaveBeenCalledWith(
    expect.objectContaining({
      updateSource: { type: 1, repo: "cashew-labs/halo" },
    }),
  );
});
