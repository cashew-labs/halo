import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { readWorkspaceServerConnection } from "@get-halo/shared/WorkspaceServerConnection";
import * as errore from "errore";

const controlPlaneHealthUrl = "http://127.0.0.1:8787/health";
const readinessPollIntervalMs = 100;
const readinessTimeoutMs = 60_000;

class DevelopmentServicesError extends errore.createTaggedError({
  name: "DevelopmentServicesError",
  message: "Local Halo services did not become ready: $detail",
}) {}

export async function waitForDevelopmentServices(): Promise<
  undefined | DevelopmentServicesError
> {
  const deadline = Date.now() + readinessTimeoutMs;
  const appDataDir = developmentAppDataDir();

  while (Date.now() < deadline) {
    const controlPlaneReady = await isHealthy(controlPlaneHealthUrl);
    const workspaceConnection = await readWorkspaceServerConnection(appDataDir);
    if (workspaceConnection instanceof Error) {
      return new DevelopmentServicesError({
        detail: "read the workspace server connection",
        cause: workspaceConnection,
      });
    }

    const workspaceServerReady =
      workspaceConnection === undefined
        ? false
        : await isHealthy(
            `${workspaceConnection.origin}/health`,
            workspaceConnection.token,
          );

    if (controlPlaneReady && workspaceServerReady) return;
    await setTimeout(readinessPollIntervalMs);
  }

  return new DevelopmentServicesError({
    detail: `timed out after ${readinessTimeoutMs / 1_000} seconds`,
  });
}

function developmentAppDataDir() {
  const configured = process.env.HALO_USER_DATA;
  return configured === undefined
    ? path.resolve(import.meta.dirname, "../../..", ".halo")
    : path.resolve(configured);
}

async function isHealthy(url: string, token?: string) {
  const response = await fetch(
    url,
    token === undefined
      ? undefined
      : { headers: { authorization: `Bearer ${token}` } },
  ).catch(() => undefined);
  return response !== undefined && response.ok;
}
