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
  signOut: () => Promise<void | Error>;
  // Returns a single-use link that lets the opened browser finish the setup
  // without a Halo sign-in, or the setup URL when it is not a Halo setup.
  createSetupHandoff?: (setupUrl: string) => Promise<string | Error>; // coverage-exempt: type declaration
};

export type DesktopIdentity = Pick<
  DesktopAuthentication,
  "getSession" | "signIn"
>;

export function createLocalDesktopAuthentication(ctx: {
  dataDir: string;
  identity: DesktopIdentity;
}): DesktopAuthentication {
  // A local identity has no saved session to revoke. Signing out hides it
  // until the next sign-in or app restart.
  let signedOut = false;
  return {
    getSession: async () =>
      signedOut ? undefined : await ctx.identity.getSession(),
    signIn: async () => {
      const session = await ctx.identity.signIn();
      if (session instanceof Error) return session;
      signedOut = false;
      return session;
    },
    signOut: async () => {
      signedOut = true;
    },
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
