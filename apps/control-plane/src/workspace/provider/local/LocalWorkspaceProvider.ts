import { readWorkspaceServerConnection } from "@get-halo/shared/WorkspaceServerConnection";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import * as errore from "errore";
import { workspaceRuntimeConfigFileName } from "@get-halo/config/workspaceServer";
import type { LoggerApi } from "@get-halo/logger";
import type {
  WorkspaceProviderApi,
  WorkspaceProviderConnection,
  WorkspaceProviderAssignment,
} from "../WorkspaceProviderApi.js";

class LocalWorkspaceProviderError extends errore.createTaggedError({
  name: "LocalWorkspaceProviderError",
  message: "Could not assign local workspace service settings",
}) {}

// Local development runs one workspace server, so it never doubles as an app VM.
class LocalAppVmUnsupportedError extends errore.createTaggedError({
  name: "LocalAppVmUnsupportedError",
  message: "Shared apps need a dedicated sandboxed app VM",
}) {}

export class LocalWorkspaceProvider implements WorkspaceProviderApi {
  private readonly appDataDir: string;
  private readonly logger: LoggerApi;

  constructor(ctx: { appDataDir: string; logger: LoggerApi }) {
    this.logger = ctx.logger;
    this.appDataDir = ctx.appDataDir;
  }

  async ensure(input: WorkspaceProviderAssignment) {
    if (input.sharedApp !== undefined) return new LocalAppVmUnsupportedError();
    await using cleanup = new errore.AsyncDisposableStack();
    // The development host owns the workspace server's lifetime.
    const directory = await fs
      .mkdir(this.appDataDir, { recursive: true, mode: 0o700 })
      .catch((cause) => new LocalWorkspaceProviderError({ cause }));
    if (directory instanceof Error) return directory;
    const temporary = path.join(
      this.appDataDir,
      `runtime-${crypto.randomUUID()}.tmp`,
    );
    cleanup.defer(async () => {
      const removed = await fs
        .rm(temporary, { force: true })
        .catch((cause) => new LocalWorkspaceProviderError({ cause }));
      if (removed instanceof Error)
        this.logger.warn({
          event: "workspace-local-runtime-cleanup-failed",
          workspaceId: input.workspaceId,
        });
    });
    const written = await fs
      .writeFile(temporary, JSON.stringify(input.runtime), { mode: 0o600 })
      .catch((cause) => new LocalWorkspaceProviderError({ cause }));
    if (written instanceof Error) return written;
    return await fs
      .rename(
        temporary,
        path.join(this.appDataDir, workspaceRuntimeConfigFileName),
      )
      .catch((cause) => new LocalWorkspaceProviderError({ cause }));
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
