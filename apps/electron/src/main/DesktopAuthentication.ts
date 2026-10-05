import type {
  ControlPlaneWorkspaceStatus,
  ControlPlaneSession,
} from "@get-halo/shared/controlPlaneContract";
import { readWorkspaceServerConnection } from "@get-halo/shared/WorkspaceServerConnection";
import type { HaloRpcConnection } from "../shared/HaloRpcConnection.js";

export type DesktopAuthentication = {
  getWorkspaceStatus?: () => Promise<
    ControlPlaneWorkspaceStatus | Error | undefined
  >;
  recordWorkspaceActivity?: () => Promise<void | Error>;
  getWorkspaceConnection: () => Promise<HaloRpcConnection | Error | undefined>;
  getSession: () => Promise<ControlPlaneSession | Error | undefined>;
  signIn: () => Promise<ControlPlaneSession | Error>;
};

export type DesktopIdentity = Pick<
  DesktopAuthentication,
  "getSession" | "signIn"
>;

export function createLocalDesktopAuthentication(ctx: {
  dataDir: string;
  identity: DesktopIdentity;
}): DesktopAuthentication {
  return {
    getSession: async () => await ctx.identity.getSession(),
    signIn: async () => await ctx.identity.signIn(),
    getWorkspaceConnection: async () => {
      const server = await readWorkspaceServerConnection(ctx.dataDir);
      if (server instanceof Error || server === undefined) return server;

      return {
        origin: server.origin,
        path: "/rpc",
        token: server.token,
        extensionPath: "/extensions",
      } satisfies HaloRpcConnection;
    },
  };
}
