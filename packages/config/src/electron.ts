import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import * as errore from "errore";
import { ApplicationMode } from "./ApplicationMode.js";

const productionControlPlaneOrigin =
  "https://halo-west-control-plane-912701444316.us-west2.run.app";
const developmentControlPlaneOrigin = "http://127.0.0.1:8787";

class ElectronConfigError extends errore.createTaggedError({
  name: "ElectronConfigError",
  message: "Electron configuration failed: $detail",
}) {}

export type ElectronConfig = {
  mode: ApplicationMode;
  controlPlaneOrigin: string;
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
    | { enabled: true }
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

  const isDevelopment = mode === ApplicationMode.Development;
  const isTest = mode === ApplicationMode.Test;
  return {
    mode,
    controlPlaneOrigin:
      mode === ApplicationMode.Production
        ? productionControlPlaneOrigin
        : developmentControlPlaneOrigin,
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
        ? { enabled: true }
        : {
            enabled: false,
            reason: isDevelopment
              ? "Dev builds do not auto-update"
              : "Test builds do not auto-update",
          },
  };
}

export const config = readConfig();
