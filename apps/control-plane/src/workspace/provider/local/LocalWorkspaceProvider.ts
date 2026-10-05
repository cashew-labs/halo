import { readWorkspaceServerConnection } from "@get-halo/shared/WorkspaceServerConnection";
import type {
  WorkspaceProviderApi,
  WorkspaceProviderConnection,
} from "../WorkspaceProviderApi.js";

export class LocalWorkspaceProvider implements WorkspaceProviderApi {
  private readonly appDataDir: string;

  constructor(ctx: { appDataDir: string }) {
    this.appDataDir = ctx.appDataDir;
  }

  async ensure() {
    // The development host owns the workspace server's lifetime.
  }

  async getConnection() {
    const server = await readWorkspaceServerConnection(this.appDataDir);
    if (server instanceof Error || server === undefined) return server;
    return {
      origin: server.origin,
      authorization: { type: "bearer", value: `Bearer ${server.token}` },
    } satisfies WorkspaceProviderConnection;
  }
}
