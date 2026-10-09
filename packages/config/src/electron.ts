import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import * as errore from "errore";
import { ApplicationMode } from "./ApplicationMode.js";
import { readReleaseChannel, type ReleaseChannel } from "./releaseChannel.js";

const developmentControlPlaneOrigin = "http://127.0.0.1:8787";

const releaseChannels = {
  production: {
    controlPlaneOrigin: "https://gethalo.dev",
    sessionFileName: "control-plane-session",
    updateRepository: "cashew-labs/halo",
  },
  staging: {
    controlPlaneOrigin: "https://staging.gethalo.dev",
    sessionFileName: "staging-control-plane-session",
    updateRepository: "cashew-labs/halo-staging",
  },
} satisfies Record<
  ReleaseChannel,
  {
    controlPlaneOrigin: string;
    sessionFileName: string;
    updateRepository: string;
  }
>;

class ElectronConfigError extends errore.createTaggedError({
  name: "ElectronConfigError",
  message: "Electron configuration failed: $detail",
}) {}

export type ElectronConfig = {
  mode: ApplicationMode;
  releaseChannel: ReleaseChannel;
  /** Holds `staging` when this install follows the staging deployment. */
  releaseChannelPath: string;
  /** Why the saved channel was ignored in favor of production, for main to log. */
  releaseChannelError: Error | undefined;
  controlPlaneOrigin: string;
  controlPlaneSessionPath: string;
  dataDir: string;
  logsDir: string;
  logFilePath: string;
  prettyConsoleLogging: boolean;
  protectClosedStdio: boolean;
  remoteDebugging: boolean;
  useSwiftShader: boolean;
  showMainWindow: boolean;
  testWindowEvents: boolean;
  updates:
    | { enabled: true; repository: string }
    | {
        enabled: false;
        reason:
          | "Dev builds do not auto-update"
          | "Test builds do not auto-update";
      };
};

function readConfig(): ElectronConfig | Error {
  const mode =
    process.env.HALO_E2E === "1"
      ? ApplicationMode.Test
      : app.isPackaged
        ? ApplicationMode.Production
        : ApplicationMode.Development;
  const configuredDataDir = process.env.HALO_USER_DATA;
  const dataDir =
    configuredDataDir === undefined
      ? mode === ApplicationMode.Development
        ? path.resolve(app.getAppPath(), "../..", ".halo")
        : app.getPath("userData")
      : path.resolve(configuredDataDir);
  const configured = errore.try({
    try: () => app.setPath("userData", dataDir),
    catch: (cause) =>
      new ElectronConfigError({ detail: "set application data path", cause }),
  });
  if (configured instanceof Error) return configured;

  const logsDir = path.join(dataDir, "logs");
  const created = errore.try({
    try: () => fs.mkdirSync(logsDir, { recursive: true }),
    catch: (cause) =>
      new ElectronConfigError({ detail: "create log directory", cause }),
  });
  if (created instanceof Error) return created;

  const releaseChannelPath = path.join(dataDir, "release-channel");
  // A damaged preference must not prevent launch; production remains reachable.
  const savedReleaseChannel = readReleaseChannel(releaseChannelPath);
  const releaseChannel =
    savedReleaseChannel instanceof Error ? "production" : savedReleaseChannel;
  const channel = releaseChannels[releaseChannel];

  const isDevelopment = mode === ApplicationMode.Development;
  const isTest = mode === ApplicationMode.Test;
  return {
    mode,
    releaseChannel,
    releaseChannelPath,
    releaseChannelError:
      savedReleaseChannel instanceof Error ? savedReleaseChannel : undefined,
    controlPlaneOrigin:
      mode === ApplicationMode.Production
        ? channel.controlPlaneOrigin
        : developmentControlPlaneOrigin,
    controlPlaneSessionPath: path.join(dataDir, channel.sessionFileName),
    dataDir,
    logsDir,
    logFilePath: path.join(
      logsDir,
      isDevelopment
        ? `${new Date().toISOString().slice(0, 10)}.jsonl`
        : "halo.jsonl",
    ),
    prettyConsoleLogging: mode !== ApplicationMode.Production,
    protectClosedStdio: isDevelopment,
    remoteDebugging: isDevelopment,
    useSwiftShader: process.env.HALO_USE_SWIFTSHADER === "1",
    showMainWindow:
      !isTest ||
      process.env.HALO_E2E_HEADFUL === "1" ||
      process.env.PWDEBUG === "1",
    testWindowEvents: isTest,
    updates:
      mode === ApplicationMode.Production
        ? { enabled: true, repository: channel.updateRepository }
        : {
            enabled: false,
            reason: isDevelopment
              ? "Dev builds do not auto-update"
              : "Test builds do not auto-update",
          },
  };
}

export const config = readConfig();
