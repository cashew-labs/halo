import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { WorkspaceConfig } from "@get-halo/config/controlPlane";
import { readWorkspaceServerConnection } from "@get-halo/shared/WorkspaceServerConnection";
import * as errore from "errore";
import type { DatabaseService } from "../DatabaseService.js";
import {
  getGcpWorkspaceStatus,
  provisionGcpWorkspace,
  stopGcpWorkspace,
} from "./gcpProvisioning.js";

class WorkspaceServiceError extends errore.createTaggedError({
  name: "WorkspaceServiceError",
  message: "Workspace service failed: $detail",
}) {}

type SqliteWorkspaceRow = {
  id: string;
  created_at: string;
};

type PostgresWorkspaceRow = {
  id: string;
  created_at: Date;
};

type WorkspaceOwnerRow = { user_id: string };

type Workspace = {
  id: string;
  createdAt: Date;
};

type GcpWorkspaceConfig = Extract<WorkspaceConfig, { deployment: "gcp" }>;

type WorkspaceServiceConfig =
  | { deployment: "local"; appDataDir: string }
  | GcpWorkspaceConfig;

export type WorkspaceConnection =
  | {
      origin: string;
      authorization: { type: "bearer"; value: string };
    }
  | {
      origin: string;
      authorization: { type: "googleIdentity" };
    };

export class WorkspaceService {
  // Tracks transitions initiated by this process until Compute Engine finishes them.
  private readonly transitions = new Map<string, "starting" | "stopping">();
  private readonly transitionErrors = new Map<string, Error>();
  private readonly activeRequests = new Map<string, number>();
  private readonly db: DatabaseService;
  private readonly config: WorkspaceServiceConfig;

  private constructor(ctx: {
    config: WorkspaceServiceConfig;
    db: DatabaseService;
  }) {
    this.db = ctx.db;
    this.config = ctx.config;
  }

  static async start(ctx: {
    config: WorkspaceServiceConfig;
    db: DatabaseService;
  }) {
    const service = new WorkspaceService(ctx);
    const migrated = await service.migrate();
    if (migrated instanceof Error) return migrated;

    return service;
  }

  async ensure(userId: string) {
    const workspace = await this.ensureRecord(userId);
    if (workspace instanceof Error) return workspace;

    if (this.config.deployment === "local")
      return { ...workspace, status: "running" as const };

    const transitionError = this.transitionErrors.get(workspace.id);
    if (transitionError !== undefined) {
      this.transitionErrors.delete(workspace.id);
      return transitionError;
    }
    const transition = this.transitions.get(workspace.id);
    if (transition !== undefined) return { ...workspace, status: transition };

    const status = await getGcpWorkspaceStatus({
      config: this.config,
      workspaceId: workspace.id,
    });
    if (status instanceof Error) return status;
    const pending = this.transitions.get(workspace.id);
    if (pending !== undefined) return { ...workspace, status: pending };
    if (status !== "stopped") return { ...workspace, status };

    this.transitions.set(workspace.id, "starting");
    void provisionGcpWorkspace({
      config: this.config,
      ownerUserId: userId,
      workspaceId: workspace.id,
    }).then(
      (result) => {
        if (result instanceof Error) {
          console.error(result);
          this.transitionErrors.set(workspace.id, result);
        }
        this.transitions.delete(workspace.id);
      },
      (cause) => {
        const error = new WorkspaceServiceError({
          detail: "start workspace VM",
          cause,
        });
        console.error(error);
        this.transitionErrors.set(workspace.id, error);
        this.transitions.delete(workspace.id);
      },
    );
    return { ...workspace, status: "starting" as const };
  }

  async wake(workspaceId: string) {
    const client = this.db.client;
    if (client instanceof DatabaseSync)
      return new WorkspaceServiceError({ detail: "wake local workspace VM" });
    const owner = await client
      .query<WorkspaceOwnerRow>("SELECT user_id FROM workspace WHERE id = $1", [
        workspaceId,
      ])
      .catch(
        (cause) =>
          new WorkspaceServiceError({ detail: "load workspace owner", cause }),
      );
    if (owner instanceof Error) return owner;
    const userId = owner.rows[0]?.user_id;
    if (userId === undefined)
      return new WorkspaceServiceError({ detail: "find workspace owner" });
    return await this.ensure(userId);
  }

  sleep(workspaceId: string) {
    if (this.config.deployment === "local") return;
    if (this.transitions.has(workspaceId)) return;
    this.transitions.set(workspaceId, "stopping");
    void stopGcpWorkspace({
      config: this.config,
      workspaceId,
    }).then(
      (result) => {
        if (result instanceof Error) {
          console.error(result);
          this.transitionErrors.set(workspaceId, result);
        }
        this.transitions.delete(workspaceId);
      },
      (cause) => {
        const error = new WorkspaceServiceError({
          detail: "stop workspace VM",
          cause,
        });
        console.error(error);
        this.transitionErrors.set(workspaceId, error);
        this.transitions.delete(workspaceId);
      },
    );
  }

  hasActiveRequests(workspaceId: string) {
    return (this.activeRequests.get(workspaceId) ?? 0) > 0;
  }

  async openRequest(userId: string) {
    if (this.config.deployment === "local") return () => undefined;
    const client = this.db.client;
    if (client instanceof DatabaseSync)
      return new WorkspaceServiceError({ detail: "open production database" });
    const touched = await client
      .query<{ id: string }>(
        `UPDATE workspace SET last_activity_at = NOW()
         WHERE user_id = $1 RETURNING id`,
        [userId],
      )
      .catch(
        (cause) =>
          new WorkspaceServiceError({
            detail: "record workspace activity",
            cause,
          }),
      );
    if (touched instanceof Error) return touched;
    const workspaceId = touched.rows[0]?.id;
    if (workspaceId === undefined)
      return new WorkspaceServiceError({ detail: "find active workspace" });
    this.activeRequests.set(
      workspaceId,
      (this.activeRequests.get(workspaceId) ?? 0) + 1,
    );
    return () => {
      const remaining = (this.activeRequests.get(workspaceId) ?? 1) - 1;
      if (remaining === 0) this.activeRequests.delete(workspaceId);
      else this.activeRequests.set(workspaceId, remaining);
    };
  }

  connectionForId(workspaceId: string) {
    if (this.config.deployment === "local") return;
    return `http://halo-${workspaceId}.${this.config.zone}.c.${this.config.projectId}.internal:8788`;
  }

  async getConnection(userId: string) {
    if (this.config.deployment === "local") {
      const server = await readWorkspaceServerConnection(
        this.config.appDataDir,
      );
      if (server instanceof Error || server === undefined) return server;
      return {
        origin: server.origin,
        authorization: {
          type: "bearer",
          value: `Bearer ${server.token}`,
        },
      } satisfies WorkspaceConnection;
    }

    const workspace = await this.findRecord(userId);
    if (workspace instanceof Error) return workspace;
    if (workspace === undefined) {
      return new WorkspaceServiceError({ detail: "find workspace" });
    }

    const origin = this.connectionForId(workspace.id);
    if (origin === undefined)
      return new WorkspaceServiceError({ detail: "find workspace origin" });
    return {
      origin,
      authorization: { type: "googleIdentity" },
    } satisfies WorkspaceConnection;
  }

  async hasWorkspace(workspaceId: string) {
    const client = this.db.client;
    if (client instanceof DatabaseSync) {
      return errore.try({
        try: () =>
          client
            .prepare("SELECT id FROM workspace WHERE id = ?")
            .get(workspaceId) !== undefined,
        catch: (cause) =>
          new WorkspaceServiceError({
            detail: "authorize trace workspace",
            cause,
          }),
      });
    }
    const found = await client
      .query("SELECT id FROM workspace WHERE id = $1", [workspaceId])
      .catch(
        (cause) =>
          new WorkspaceServiceError({
            detail: "authorize trace workspace",
            cause,
          }),
      );
    if (found instanceof Error) return found;
    return found.rows.length === 1;
  }

  private async findRecord(userId: string) {
    const client = this.db.client;

    if (client instanceof DatabaseSync) {
      return errore.try({
        try: () => {
          // SAFETY: The query selects the fields represented by SqliteWorkspaceRow.
          const row = client
            .prepare(
              `SELECT id, created_at
               FROM workspace
               WHERE user_id = ?`,
            )
            .get(userId) as SqliteWorkspaceRow | undefined;

          if (row === undefined) return undefined;
          return {
            id: row.id,
            createdAt: new Date(row.created_at),
          } satisfies Workspace;
        },
        catch: (cause) =>
          new WorkspaceServiceError({ detail: "load workspace", cause }),
      });
    }

    const selected = await client
      .query<PostgresWorkspaceRow>(
        `SELECT id, created_at
         FROM workspace
         WHERE user_id = $1`,
        [userId],
      )
      .catch(
        (cause) =>
          new WorkspaceServiceError({ detail: "load workspace", cause }),
      );
    if (selected instanceof Error) return selected;

    const row = selected.rows[0];
    if (row === undefined) return undefined;
    return { id: row.id, createdAt: row.created_at } satisfies Workspace;
  }

  private async ensureRecord(userId: string) {
    const client = this.db.client;
    const workspaceId = crypto.randomUUID();
    const createdAt = new Date();

    if (client instanceof DatabaseSync) {
      const inserted = errore.try({
        try: () => {
          client
            .prepare(
              `INSERT INTO workspace (id, user_id, created_at)
               VALUES (?, ?, ?)
               ON CONFLICT (user_id) DO NOTHING`,
            )
            .run(workspaceId, userId, createdAt.toISOString());
        },
        catch: (cause) =>
          new WorkspaceServiceError({ detail: "ensure workspace", cause }),
      });
      if (inserted instanceof Error) return inserted;
    } else {
      const inserted = await client
        .query(
          `INSERT INTO workspace (id, user_id, created_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id) DO NOTHING`,
          [workspaceId, userId, createdAt],
        )
        .catch(
          (cause) =>
            new WorkspaceServiceError({ detail: "ensure workspace", cause }),
        );
      if (inserted instanceof Error) return inserted;
    }

    const workspace = await this.findRecord(userId);
    if (workspace instanceof Error) return workspace;
    if (workspace === undefined) {
      return new WorkspaceServiceError({ detail: "find ensured workspace" });
    }

    return workspace;
  }

  private async migrate() {
    const client = this.db.client;

    if (client instanceof DatabaseSync) {
      return errore.try({
        try: () =>
          client.exec(`CREATE TABLE IF NOT EXISTS workspace (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL
          )`),
        catch: (cause) =>
          new WorkspaceServiceError({
            detail: "migrate SQLite schema",
            cause,
          }),
      });
    }

    return await client
      .query(`CREATE TABLE IF NOT EXISTS workspace (
        id UUID PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL,
        last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`)
      .then(async () => {
        await client.query(
          "ALTER TABLE workspace ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
        );
      })
      .catch(
        (cause) =>
          new WorkspaceServiceError({
            detail: "migrate PostgreSQL schema",
            cause,
          }),
      );
  }
}
