import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import * as errore from "errore";
import type { HaloClient } from "@get-halo/shared/contract";
import type { ControlPlaneSession } from "@get-halo/shared/controlPlaneContract";
import type { HostApi } from "../../shared/desktop.js";
import type { HaloRpcConnection } from "../../shared/HaloRpcConnection.js";

class WebHostError extends errore.createTaggedError({
  name: "WebHostError",
  message: "Halo could not $operation",
}) {}

// Local web uses the machine operator. Cookie Google sign-in is a later fill.
const localWebSession: ControlPlaneSession = {
  session: {
    id: "web-host",
    userId: "web-host",
    expiresAt: "2100-01-01T00:00:00.000Z",
  },
  user: {
    id: "web-host",
    email: "web@localhost",
    name: "Local web",
  },
};

type PublishedConnection = {
  token: string;
};

export function createWebHost(): HostApi {
  return {
    openWorkspaceFile: async () => {
      throw new WebHostError({
        operation: "open a file in the system viewer from the browser",
      });
    },
    getConnection,
    getAuthSession: async () => localWebSession,
    signIn: async () => localWebSession,
    getAppInfo: async () => ({
      version: "web",
      update: {
        state: "disabled",
        reason: "Web hosts do not auto-update",
      },
    }),
    installAppUpdate: async () => undefined,
    openExternal: async (request) => {
      const url = errore.try({
        try: () => new URL(request.url),
        catch: (cause) =>
          new WebHostError({
            operation: "open an invalid external URL",
            cause,
          }),
      });
      if (url instanceof Error) throw url;
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new WebHostError({
          operation: `open an external ${url.protocol} URL`,
        });
      }
      window.open(url.toString(), "_blank", "noopener,noreferrer");
    },
    connectIntegration: async (input) => {
      const connection = await getConnection();
      if (connection === undefined) {
        throw new WebHostError({
          operation: "start a connection without a workspace",
        });
      }
      const client = createWorkspaceClient(connection);
      const started = await client.sessions
        .startConnection({
          sessionId: input.sessionId,
          request: input.request,
          redirectUri: `${window.location.origin}/`,
        })
        .catch(
          (cause) =>
            new WebHostError({
              operation: "start the connection",
              cause,
            }),
        );
      if (started instanceof Error) throw started;
      if (started.status === "authorization-required") {
        window.open(started.authorizationUrl, "_blank", "noopener,noreferrer");
      }
      return started;
    },
    cancelIntegration: async (input) => {
      const connection = await getConnection();
      if (connection === undefined) {
        throw new WebHostError({
          operation: "cancel a connection without a workspace",
        });
      }
      const cancelled = await createWorkspaceClient(connection)
        .sessions.cancelConnection({
          sessionId: input.sessionId,
          connectionId: input.connectionId,
        })
        .catch(
          (cause) =>
            new WebHostError({
              operation: "cancel the connection",
              cause,
            }),
        );
      if (cancelled instanceof Error) throw cancelled;
    },
  };
}

async function getConnection(): Promise<HaloRpcConnection | undefined> {
  const response = await fetch("/__halo/connection").catch(
    (cause) => new WebHostError({ operation: "find the workspace", cause }),
  );
  if (response instanceof Error) throw response;
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new WebHostError({ operation: "find the workspace" });
  }
  // SAFETY: /__halo/connection responds with PublishedConnection JSON.
  const published = await (
    response.json() as Promise<PublishedConnection>
  ).catch(
    (cause) => new WebHostError({ operation: "read the workspace", cause }),
  );
  if (published instanceof Error) throw published;
  return {
    origin: window.location.origin,
    path: "/rpc",
    token: published.token,
    extensionPath: "/extensions",
  };
}

function createWorkspaceClient(connection: HaloRpcConnection) {
  const link = new RPCLink({
    origin: connection.origin,
    url: connection.path,
    headers: { authorization: `Bearer ${connection.token}` },
  });
  // SAFETY: HaloRpcConnection points to the Halo router.
  return createORPCClient(link) as HaloClient;
}
