import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  checkControlPlaneCompatibility,
  controlPlaneProtocolVersion,
  type ControlPlaneClient,
} from "@get-halo/shared/controlPlaneContract";
import {
  connectHaloClient,
  AuthenticationRequiredError,
  ConnectionHttpError,
  protocolHeader,
  type HaloClient,
} from "@get-halo/client";
import type { AppInfo, HostApi } from "@get-halo/web/HostApi";
import { createAuthClient } from "better-auth/client";
import * as errore from "errore";

class WebHostError extends errore.createTaggedError({
  name: "WebHostError",
  message: "Halo could not $operation through its web host.",
}) {}

export class WebHost implements HostApi {
  async getAppInfo(): Promise<AppInfo> {
    return {
      version: import.meta.env.VITE_HALO_VERSION,
      development: import.meta.env.VITE_HALO_DEVELOPMENT,
      update: { state: "disabled", reason: "Browser updates arrive on reload" },
    };
  }

  async getWorkspaceStatus() {
    return await this.controlPlane.workspace
      .status(undefined, {
        signal: AbortSignal.timeout(10_000),
      })
      .catch(
        (cause) =>
          new WebHostError({ operation: "read workspace status", cause }),
      );
  }

  async recordWorkspaceActivity() {
    const workspace = await this.controlPlane.workspace
      .ensure(undefined, { signal: AbortSignal.timeout(60_000) })
      .catch(
        (cause) => new WebHostError({ operation: "wake the workspace", cause }),
      );
    if (workspace instanceof Error) return workspace;
  }

  readonly showLandingPage = true;

  // Tracks the active workspace client for integration connections.
  private haloClient: HaloClient | undefined;

  // Connects to the control plane served on the current origin.
  private readonly controlPlane = createORPCClient<ControlPlaneClient>(
    new RPCLink({
      origin: window.location.origin,
      url: "/rpc",
      headers: { [protocolHeader]: String(controlPlaneProtocolVersion) },
    }),
  );
  // Owns browser authentication for this host.
  private readonly authClient = createAuthClient();

  readonly integrationSetup: NonNullable<HostApi["integrationSetup"]> = {
    read: async (setupId) =>
      await this.controlPlane.integrations
        .setup({ setupId })
        .catch(
          (cause) =>
            new WebHostError({ operation: "read connection setup", cause }),
        ),
    submit: async (input) =>
      await this.controlPlane.integrations
        .submitSetup(input)
        .catch(
          (cause) =>
            new WebHostError({ operation: "create the connection", cause }),
        ),
    cancel: async (setupId) =>
      await this.controlPlane.integrations
        .cancelSetup({ setupId })
        .catch(
          (cause) =>
            new WebHostError({ operation: "cancel connection setup", cause }),
        ),
    redeemHandoff: async (input) =>
      await this.controlPlane.integrations
        .redeemSetupHandoff(input)
        .catch(
          (cause) =>
            new WebHostError({ operation: "open connection setup", cause }),
        ),
    signIn: async () => await this.signIn(),
  };

  async getAuthSession() {
    const compatible = await checkControlPlaneCompatibility(
      this.controlPlane,
      AbortSignal.timeout(10_000),
    );
    if (compatible instanceof Error) return compatible;
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
        callbackURL:
          window.location.pathname === "/login"
            ? window.location.origin
            : window.location.href,
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
    signal,
    canRequest,
  }: Parameters<HostApi["connectHalo"]>[0]) {
    const compatible = await checkControlPlaneCompatibility(
      this.controlPlane,
      signal,
    );
    if (compatible instanceof Error) return compatible;

    const health = await fetch("/workspace/health", { signal }).catch(
      (cause) =>
        new WebHostError({ operation: "reach the workspace server", cause }),
    );
    if (health instanceof Error) return health;
    if (health.status === 502 || health.status === 503) return undefined;
    if (health.status === 401) return new AuthenticationRequiredError();
    if (!health.ok)
      return new ConnectionHttpError({
        service: "workspace",
        stage: "health",
        status: health.status,
      });

    const connected = await connectHaloClient({
      transport: {
        origin: window.location.origin,
        path: "/workspace/rpc",
        headers: {},
      },
      onDisconnect,
      signal,
      canRequest,
    });
    if (connected instanceof Error) return connected;
    if (signal.aborted) return undefined;
    this.haloClient = connected.client;
    return connected.client;
  }

  getExtensionFrameUrl(extensionId: string) {
    return new URL(
      `/workspace/extensions/${encodeURIComponent(extensionId)}/view/`,
      window.location.origin,
    ).toString();
  }

  getDesktopFrameUrl() {
    return new URL("/workspace/desktop/", window.location.origin).toString();
  }

  async connectIntegration(
    input: Parameters<HostApi["connectIntegration"]>[0],
  ) {
    if (this.haloClient === undefined) {
      return new WebHostError({
        operation: "start a connection without a workspace",
      });
    }
    // Reserve the tab during the click, before the RPC consumes user activation.
    const setupPage = window.open("about:blank", "_blank");
    if (setupPage === null)
      return new WebHostError({
        operation: "open setup (allow pop-ups and retry)",
      });
    // oxlint-disable-next-line unicorn/no-null -- The DOM requires null to detach the setup tab's opener.
    setupPage.opener = null;
    const started = await this.haloClient.thread
      .startConnection(input)
      .catch(
        (cause) =>
          new WebHostError({ operation: "start the connection", cause }),
      );
    if (started instanceof Error) {
      setupPage.close();
      return started;
    }
    if (started.status === "authorization-required") {
      setupPage.location.replace(started.authorizationUrl);
      return started;
    }
    setupPage.close();
    return started;
  }

  async cancelIntegration(input: Parameters<HostApi["cancelIntegration"]>[0]) {
    if (this.haloClient === undefined) {
      return new WebHostError({
        operation: "cancel a connection without a workspace",
      });
    }
    return await this.haloClient.thread
      .cancelConnection(input)
      .then(() => undefined)
      .catch(
        (cause) =>
          new WebHostError({ operation: "cancel the connection", cause }),
      );
  }
}
