import * as errore from "errore";
import { connectHaloRpc } from "@get-halo/web/connectHaloRpc";
import type { HostApi } from "@get-halo/web/HostApi";

class ElectronHostError extends errore.createTaggedError({
  name: "ElectronHostError",
  message: "Halo could not $operation through its desktop host.",
}) {}

const desktopBridge = window.haloDesktop;
let extensionBaseUrl: URL | undefined = undefined;

export const electronHost = {
  async getAuthSession() {
    return await desktopBridge.getAuthSession().catch(
      (cause) =>
        new ElectronHostError({
          operation: "restore authentication",
          cause,
        }),
    );
  },

  async signIn() {
    return await desktopBridge
      .signIn()
      .catch((cause) => new ElectronHostError({ operation: "sign in", cause }));
  },

  async connectHalo({
    onDisconnect,
  }: {
    onDisconnect: (error: Error) => void;
  }) {
    const connection = await desktopBridge.getConnection().catch(
      (cause) =>
        new ElectronHostError({
          operation: "find the workspace server",
          cause,
        }),
    );
    if (connection instanceof Error) return connection;
    if (connection === undefined) return undefined;

    const api = await connectHaloRpc({
      transport: {
        origin: connection.origin,
        path: connection.path,
        headers: { authorization: `Bearer ${connection.token}` },
      },
      onDisconnect,
    });
    if (api instanceof Error) return api;

    extensionBaseUrl = new URL(
      `${connection.extensionPath}/`,
      connection.origin,
    );
    return api;
  },

  getExtensionFrameUrl(extensionId: string) {
    return new URL(
      `${encodeURIComponent(extensionId)}/view/`,
      extensionBaseUrl,
    ).toString();
  },

  async getAppInfo() {
    return await desktopBridge.getAppInfo().catch(
      (cause) =>
        new ElectronHostError({
          operation: "read app update information",
          cause,
        }),
    );
  },

  async installAppUpdate() {
    return await desktopBridge.installAppUpdate().catch(
      (cause) =>
        new ElectronHostError({
          operation: "install an app update",
          cause,
        }),
    );
  },

  async connectIntegration(
    input: Parameters<typeof desktopBridge.connectIntegration>[0],
  ) {
    return await desktopBridge.connectIntegration(input).catch(
      (cause) =>
        new ElectronHostError({
          operation: "start an integration connection",
          cause,
        }),
    );
  },

  async cancelIntegration(
    input: Parameters<typeof desktopBridge.cancelIntegration>[0],
  ) {
    return await desktopBridge.cancelIntegration(input).catch(
      (cause) =>
        new ElectronHostError({
          operation: "cancel an integration connection",
          cause,
        }),
    );
  },
} satisfies HostApi;
