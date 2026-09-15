import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ControlPlaneClient } from "@get-halo/shared/controlPlaneContract";
import { connectHaloRpc } from "@get-halo/web/connectHaloRpc";
import type { HostApi } from "@get-halo/web/HostApi";
import { createAuthClient } from "better-auth/client";
import * as errore from "errore";

class WebHostError extends errore.createTaggedError({
  name: "WebHostError",
  message: "Halo could not $operation through its web host.",
}) {}

class WebIntegrationUnavailableError extends errore.createTaggedError({
  name: "WebIntegrationUnavailableError",
  message: "Integration connections are not available in the web app yet.",
}) {}

// SAFETY: The current origin serves controlPlaneContract at /rpc.
const controlPlane = createORPCClient(
  new RPCLink({ origin: window.location.origin, url: "/rpc" }),
) as ControlPlaneClient;
const authClient = createAuthClient();

export const webHost = {
  async getAuthSession() {
    return await controlPlane.auth
      .session()
      .catch(
        (cause) =>
          new WebHostError({ operation: "restore authentication", cause }),
      );
  },

  async signIn() {
    const result = await authClient.signIn
      .social({
        provider: "google",
        callbackURL: window.location.href,
      })
      .catch(
        (cause) => new WebHostError({ operation: "start sign in", cause }),
      );
    if (result instanceof Error) return result;
    if (result.error !== null) {
      return new WebHostError({ operation: "sign in", cause: result.error });
    }
    return undefined;
  },

  async connectHalo({
    onDisconnect,
  }: {
    onDisconnect: (error: Error) => void;
  }) {
    const workspace = await controlPlane.workspace
      .ensure()
      .catch(
        (cause) =>
          new WebHostError({ operation: "ensure the workspace", cause }),
      );
    if (workspace instanceof Error) return workspace;

    const health = await fetch("/workspace/health").catch(
      (cause) =>
        new WebHostError({ operation: "reach the workspace server", cause }),
    );
    if (health instanceof Error) return health;
    if (health.status === 502 || health.status === 503) return undefined;
    if (!health.ok) {
      return new WebHostError({ operation: "reach the workspace server" });
    }

    return await connectHaloRpc({
      transport: {
        origin: window.location.origin,
        path: "/workspace/rpc",
        headers: {},
      },
      onDisconnect,
    });
  },

  getExtensionFrameUrl(extensionId: string) {
    return new URL(
      `/workspace/extensions/${encodeURIComponent(extensionId)}/view/`,
      window.location.origin,
    ).toString();
  },

  async connectIntegration() {
    return new WebIntegrationUnavailableError();
  },

  async cancelIntegration() {
    return new WebIntegrationUnavailableError();
  },
} satisfies HostApi;
