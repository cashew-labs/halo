import * as errore from "errore";
import {
  connectHaloClient,
  restoreConnectionFailure,
  ConnectionUnavailableError,
} from "@get-halo/client";
import type { HostApi } from "@get-halo/web/HostApi";
import type { DesktopBridge } from "../shared/desktop.js";

class ElectronHostError extends errore.createTaggedError({
  name: "ElectronHostError",
  message: "Halo could not $operation through its desktop host.",
}) {}

export class ElectronHost implements HostApi {
  // Tracks the extension endpoint for the connected workspace.
  private canRequest: ((path: string[]) => boolean) | undefined;
  private extensionBaseUrl: URL | undefined;

  // Connects this renderer to Electron's preload bridge.
  private readonly desktopBridge = window.haloDesktop;

  setHotkeys(hotkeys: Parameters<DesktopBridge["setHotkeys"]>[0]) {
    this.desktopBridge.setHotkeys(hotkeys);
  }

  onShortcut(listener: Parameters<DesktopBridge["onShortcut"]>[0]) {
    return this.desktopBridge.onShortcut(listener);
  }

  async getAuthSession() {
    const result = await this.desktopBridge.getAuthSession().catch(
      (cause) =>
        new ElectronHostError({
          operation: "restore authentication",
          cause,
        }),
    );
    return result instanceof Error ? result : restoreConnectionFailure(result);
  }

  async signIn() {
    const result = await this.desktopBridge
      .signIn()
      .catch((cause) => new ElectronHostError({ operation: "sign in", cause }));
    return result instanceof Error ? result : restoreConnectionFailure(result);
  }

  async connectHalo({
    onDisconnect,
    signal,
    canRequest,
  }: Parameters<HostApi["connectHalo"]>[0]) {
    const result = await this.desktopBridge.getConnection().catch(
      (cause) =>
        new ElectronHostError({
          operation: "find the workspace server",
          cause,
        }),
    );
    if (result instanceof Error) return result;
    if (signal.aborted) return undefined;
    const connection = restoreConnectionFailure(result);
    if (connection instanceof Error) return connection;
    if (connection === undefined) return undefined;

    const connected = await connectHaloClient({
      transport: {
        origin: connection.origin,
        path: connection.path,
        headers: { authorization: `Bearer ${connection.token}` },
      },
      onDisconnect,
      signal,
      canRequest,
    });
    if (connected instanceof Error) return connected;

    if (signal.aborted) return undefined;
    this.canRequest = canRequest;
    this.extensionBaseUrl = new URL(
      `${connection.extensionPath}/`,
      connection.origin,
    );
    return connected.client;
  }

  getExtensionFrameUrl(extensionId: string) {
    return new URL(
      `${encodeURIComponent(extensionId)}/view/`,
      this.extensionBaseUrl,
    ).toString();
  }

  async getAppInfo() {
    return await this.desktopBridge.getAppInfo().catch(
      (cause) =>
        new ElectronHostError({
          operation: "read app update information",
          cause,
        }),
    );
  }

  async checkForAppUpdate() {
    return await this.desktopBridge.checkForAppUpdate().catch(
      (cause) =>
        new ElectronHostError({
          operation: "check for an app update",
          cause,
        }),
    );
  }

  async installAppUpdate() {
    return await this.desktopBridge.installAppUpdate().catch(
      (cause) =>
        new ElectronHostError({
          operation: "install an app update",
          cause,
        }),
    );
  }

  async openExternalUrl(url: string) {
    return await this.desktopBridge.openExternal({ url }).catch(
      (cause) =>
        new ElectronHostError({
          operation: "open an external URL",
          cause,
        }),
    );
  }

  async connectIntegration(
    input: Parameters<DesktopBridge["connectIntegration"]>[0],
  ) {
    if (this.canRequest?.(["sessions", "startConnection"]) !== true)
      return new ConnectionUnavailableError();
    return await this.desktopBridge.connectIntegration(input).catch(
      (cause) =>
        new ElectronHostError({
          operation: "start an integration connection",
          cause,
        }),
    );
  }

  async cancelIntegration(
    input: Parameters<DesktopBridge["cancelIntegration"]>[0],
  ) {
    if (this.canRequest?.(["sessions", "cancelConnection"]) !== true)
      return new ConnectionUnavailableError();
    return await this.desktopBridge.cancelIntegration(input).catch(
      (cause) =>
        new ElectronHostError({
          operation: "cancel an integration connection",
          cause,
        }),
    );
  }
}
