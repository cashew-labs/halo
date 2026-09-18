import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ControlPlaneClient } from "@get-halo/shared/controlPlaneContract";
import { connectHaloClient, type HaloClient } from "@get-halo/client";
import type { HostApi, SignedOutView } from "@get-halo/web/HostApi";
import { createAuthClient } from "better-auth/client";
import * as errore from "errore";

class WebHostError extends errore.createTaggedError({
  name: "WebHostError",
  message: "Halo could not $operation through its web host.",
}) {}

export class WebHost implements HostApi {
  // Tracks the active workspace client for integration connections.
  private haloClient: HaloClient | undefined;

  signedOutView(path: string): SignedOutView {
    return path === "/" ? "public-site" : "sign-in";
  }

  // Connects to the control plane served on the current origin.
  private readonly controlPlane = createORPCClient<ControlPlaneClient>(
    new RPCLink({ origin: window.location.origin, url: "/rpc" }),
  );
  // Owns browser authentication for this host.
  private readonly authClient = createAuthClient();

  async getAuthSession() {
    const authentication = await this.controlPlane.auth
      .session()
      .catch(
        (cause) =>
          new WebHostError({ operation: "restore authentication", cause }),
      );
    if (authentication instanceof Error) return authentication;
    if (authentication.status === "signed-out") return undefined;
    return authentication.session;
  }

  async signIn() {
    const result = await this.authClient.signIn
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
  }

  async connectHalo({
    onDisconnect,
  }: {
    onDisconnect: (error: Error) => void;
  }) {
    this.haloClient = undefined;
    const workspace = await this.controlPlane.workspace
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

    const connected = await connectHaloClient({
      transport: {
        origin: window.location.origin,
        path: "/workspace/rpc",
        headers: {},
      },
      onDisconnect: (error) => {
        this.haloClient = undefined;
        onDisconnect(error);
      },
    });
    if (connected instanceof Error) return connected;
    this.haloClient = connected.client;
    return connected.client;
  }

  getExtensionFrameUrl(extensionId: string) {
    return new URL(
      `/workspace/extensions/${encodeURIComponent(extensionId)}/view/`,
      window.location.origin,
    ).toString();
  }

  async connectIntegration(
    input: Parameters<HostApi["connectIntegration"]>[0],
  ) {
    if (this.haloClient === undefined) {
      return new WebHostError({
        operation: "start a connection without a workspace",
      });
    }
    const started = await this.haloClient.sessions
      .startConnection({
        ...input,
        completion: {
          kind: "server-redirect",
          redirectUri: new URL(
            "/workspace/oauth/callback",
            window.location.origin,
          ).toString(),
        },
      })
      .catch(
        (cause) =>
          new WebHostError({ operation: "start the connection", cause }),
      );
    if (started instanceof Error) return started;
    if (started.status === "authorization-required") {
      window.location.assign(started.authorizationUrl);
    }
    return started;
  }

  async cancelIntegration(input: Parameters<HostApi["cancelIntegration"]>[0]) {
    if (this.haloClient === undefined) {
      return new WebHostError({
        operation: "cancel a connection without a workspace",
      });
    }
    return await this.haloClient.sessions
      .cancelConnection(input)
      .then(() => undefined)
      .catch(
        (cause) =>
          new WebHostError({ operation: "cancel the connection", cause }),
      );
  }
}
