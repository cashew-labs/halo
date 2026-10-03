import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as errore from "errore";
import type { DatabaseService } from "../DatabaseService.js";
import type { WorkspaceProviderApi } from "./provider/WorkspaceProviderApi.js";

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

type Workspace = {
  id: string;
  createdAt: Date;
};

export class WorkspaceService {
  private readonly db: DatabaseService;
  private readonly provider: WorkspaceProviderApi;

  private constructor(ctx: {
    provider: WorkspaceProviderApi;
    db: DatabaseService;
  }) {
    this.db = ctx.db;
    this.provider = ctx.provider;
  }

  static async start(ctx: {
    provider: WorkspaceProviderApi;
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

    const provisioned = await this.provider.ensure({
      ownerUserId: userId,
      workspaceId: workspace.id,
    });
    if (provisioned instanceof Error) return provisioned;

    return workspace;
  }

  async getConnection(userId: string) {
    // Gateway traffic may arrive before an explicit ensure; only store identity here.
    const workspace = await this.ensureRecord(userId);
    if (workspace instanceof Error) return workspace;
    return await this.provider.getConnection({
      workspaceId: workspace.id,
      ownerUserId: userId,
    });
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
    const existing = await this.findRecord(userId);
    if (existing instanceof Error) return existing;
    if (existing !== undefined) return existing;
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
        created_at TIMESTAMPTZ NOT NULL
      )`)
      .then(() => undefined)
      .catch(
        (cause) =>
          new WorkspaceServiceError({
            detail: "migrate PostgreSQL schema",
            cause,
          }),
      );
  }
}
