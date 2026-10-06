import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as errore from "errore";
import type { ControlPlaneWorkspaceStatus } from "@get-halo/shared/controlPlaneContract";
import type { DatabaseService } from "../DatabaseService.js";
import type { WorkspaceProviderApi } from "./provider/WorkspaceProviderApi.js";
import {
  AuthService,
  WorkspaceAuthenticationRequiredError,
} from "../auth/AuthService.js";

class WorkspaceServiceError extends errore.createTaggedError({
  name: "WorkspaceServiceError",
  message: "Workspace service failed: $detail",
}) {}

type SqliteWorkspaceRow = {
  id: string;
  created_at: string;
  runtime_key_id: string | null;
  runtime_key: string | null;
  runtime_key_generation: number;
  activity_at: number;
};

type PostgresWorkspaceRow = {
  id: string;
  created_at: Date;
  runtime_key_id: string | null;
  runtime_key: string | null;
  runtime_key_generation: number;
  activity_at: string;
};

type Workspace = {
  id: string;
  createdAt: Date;
  runtimeCredential: { keyId: string; encryptedKey: string } | undefined;
  runtimeKeyGeneration: number;
  activityAt: number;
};

export class WorkspaceService {
  // Transient operations owned by this instance; Exe is authoritative when finished.
  private readonly pauses = new Set<{
    workspaceId: string;
    activityAt: number;
  }>();
  private readonly db: DatabaseService;
  private readonly provider: WorkspaceProviderApi;
  private readonly auth: AuthService;
  private readonly origin: string;
  private readonly idleTimeoutMs: number;

  private constructor(ctx: {
    provider: WorkspaceProviderApi;
    db: DatabaseService;
    auth: AuthService;
    origin: string;
    idleTimeoutMs?: number;
  }) {
    this.db = ctx.db;
    this.provider = ctx.provider;
    this.auth = ctx.auth;
    this.origin = ctx.origin;
    this.idleTimeoutMs = ctx.idleTimeoutMs ?? 30 * 60_000;
  }

  static async start(ctx: {
    provider: WorkspaceProviderApi;
    db: DatabaseService;
    auth: AuthService;
    origin: string;
    idleTimeoutMs?: number;
  }) {
    const service = new WorkspaceService(ctx);
    const migrated = await service.migrate();
    if (migrated instanceof Error) return migrated;

    return service;
  }

  async ensure(userId: string) {
    const record = await this.ensureRecord(userId);
    if (record instanceof Error) return record;
    const touched = await this.recordActivity(userId);
    if (touched instanceof Error) return touched;
    const workspace = await this.ensureRuntimeCredential({
      userId,
      workspace: record,
    });
    if (workspace instanceof Error) return workspace;
    if (workspace.runtimeCredential === undefined)
      return new WorkspaceServiceError({
        detail: "find assigned workspace key",
      });
    const token = await this.auth.readWorkspaceToken(
      workspace.runtimeCredential.encryptedKey,
    );
    if (token instanceof Error) return token;

    const provisioned = await this.provider.ensure({
      ownerUserId: userId,
      workspaceId: workspace.id,
      runtime: {
        origin: this.origin,
        workspaceId: workspace.id,
        token,
        generation: workspace.runtimeKeyGeneration,
      },
    });
    if (provisioned instanceof Error) return provisioned;

    return workspace;
  }

  async getStatus(
    userId: string,
  ): Promise<ControlPlaneWorkspaceStatus | Error> {
    const workspace = await this.findRecord(userId);
    if (workspace instanceof Error) return workspace;
    if (workspace === undefined) return { status: "running" };
    const pausing = [...this.pauses].filter(
      (pause) => pause.workspaceId === workspace.id,
    );
    if (pausing.length > 0)
      return {
        status: pausing.some(
          (pause) => pause.activityAt === workspace.activityAt,
        )
          ? "sleeping"
          : "waking",
      };
    const status = await this.provider.getStatus?.({
      workspaceId: workspace.id,
      ownerUserId: userId,
    });
    if (status instanceof Error) return status;
    return { status: status === "paused" ? "asleep" : "running" };
  }

  async authenticateRuntime(headers: Headers) {
    const identity = await this.authenticateRuntimeOwner(headers);
    if (identity instanceof Error) return identity;
    return { workspaceId: identity.workspaceId };
  }

  private async authenticateRuntimeOwner(headers: Headers) {
    const identity = await this.auth.verifyWorkspaceToken(headers);
    if (identity instanceof Error) return identity;
    const workspace = await this.findRecord(identity.userId);
    if (workspace instanceof Error) return workspace;
    if (
      workspace === undefined ||
      workspace.runtimeCredential?.keyId !== identity.keyId
    )
      return new WorkspaceAuthenticationRequiredError();
    return { workspaceId: workspace.id, ownerUserId: identity.userId };
  }

  // Only explicit activity/ensure wakes a VM; gateway lookups remain read-only.
  async reportIdle(headers: Headers, idle: boolean) {
    const identity = await this.authenticateRuntimeOwner(headers);
    if (identity instanceof Error) return identity;
    if (this.provider.pause === undefined || this.provider.resume === undefined)
      return;
    if (!idle) {
      const touched = await this.recordActivity(identity.ownerUserId);
      if (touched instanceof Error) return touched;
      return await this.provider.resume(identity);
    }
    const before = await this.findRecord(identity.ownerUserId);
    if (before instanceof Error) return before;
    if (
      before === undefined ||
      Date.now() - before.activityAt < this.idleTimeoutMs
    )
      return;
    if (
      [...this.pauses].some(
        (pause) => pause.workspaceId === identity.workspaceId,
      )
    )
      return;
    const pause = {
      workspaceId: identity.workspaceId,
      activityAt: before.activityAt,
    };
    this.pauses.add(pause);
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => this.pauses.delete(pause));
    const paused = await this.provider.pause(identity);
    if (paused instanceof Error) {
      // Another control-plane instance may have paused the same idle VM.
      // Only new activity warrants waking it after a failed pause request.
      const after = await this.findRecord(identity.ownerUserId);
      if (after instanceof Error) {
        console.error(after);
        return paused;
      }
      if (after === undefined || after.activityAt !== before.activityAt) {
        const resumed = await this.provider.resume(identity);
        if (resumed instanceof Error) console.error(resumed);
      }
      return paused;
    }
    const after = await this.findRecord(identity.ownerUserId);
    if (after instanceof Error) {
      const resumed = await this.provider.resume(identity);
      if (resumed instanceof Error) console.error(resumed);
      return after;
    }
    if (after === undefined || after.activityAt !== before.activityAt)
      return await this.provider.resume(identity);
  }

  private async recordActivity(userId: string) {
    const client = this.db.client;
    const now = Date.now();
    // Monotonic even for two events in the same millisecond; shared across instances.
    const sql = `UPDATE workspace SET activity_at = CASE
      WHEN activity_at >= $1 THEN activity_at + 1 ELSE $1 END WHERE user_id = $2`;
    if (client instanceof DatabaseSync) {
      return errore.try({
        try: () =>
          client.prepare(sql.replace(/\$\d+/gu, "?")).run(now, now, userId),
        catch: (cause) =>
          new WorkspaceServiceError({
            detail: "record workspace activity",
            cause,
          }),
      });
    }
    return await client.query(sql, [now, userId]).catch(
      (cause) =>
        new WorkspaceServiceError({
          detail: "record workspace activity",
          cause,
        }),
    );
  }

  async rotateRuntimeToken(userId: string) {
    const workspace = await this.findRecord(userId);
    if (workspace instanceof Error) return workspace;
    if (workspace?.runtimeCredential === undefined)
      return await this.ensure(userId);
    const revoked = await this.auth.revokeWorkspaceCredential({
      userId,
      keyId: workspace.runtimeCredential.keyId,
    });
    if (revoked instanceof Error) return revoked;
    const cleared = await this.storeRuntimeCredential({
      workspaceId: workspace.id,
      previousKeyId: workspace.runtimeCredential.keyId,
      credential: undefined,
    });
    if (cleared instanceof Error) return cleared;
    return await this.ensure(userId);
  }

  private async ensureRuntimeCredential(ctx: {
    userId: string;
    workspace: Workspace;
  }) {
    if (ctx.workspace.runtimeCredential !== undefined) return ctx.workspace;
    const credential = await this.auth.createWorkspaceCredential({
      userId: ctx.userId,
      workspaceId: ctx.workspace.id,
    });
    if (credential instanceof Error) return credential;
    const stored = await this.storeRuntimeCredential({
      workspaceId: ctx.workspace.id,
      previousKeyId: undefined,
      credential,
    });
    if (stored instanceof Error) {
      const revoked = await this.auth.revokeWorkspaceCredential({
        userId: ctx.userId,
        keyId: credential.keyId,
      });
      return revoked instanceof Error ? revoked : stored;
    }
    const workspace = await this.findRecord(ctx.userId);
    if (workspace instanceof Error) return workspace;
    if (workspace === undefined)
      return new WorkspaceServiceError({ detail: "find assigned workspace" });
    if (workspace.runtimeCredential?.keyId !== credential.keyId) {
      const revoked = await this.auth.revokeWorkspaceCredential({
        userId: ctx.userId,
        keyId: credential.keyId,
      });
      if (revoked instanceof Error) return revoked;
    }
    return workspace;
  }

  private async storeRuntimeCredential(ctx: {
    workspaceId: string;
    previousKeyId: string | undefined;
    credential: { keyId: string; encryptedKey: string } | undefined;
  }) {
    const client = this.db.client;
    const values = [
      // oxlint-disable-next-line unicorn/no-null -- SQL NULL clears the credential.
      ctx.credential?.keyId ?? null,
      // oxlint-disable-next-line unicorn/no-null -- node:sqlite does not bind undefined.
      ctx.credential?.encryptedKey ?? null,
      ctx.workspaceId,
    ];
    if (client instanceof DatabaseSync) {
      return errore.try({
        try: () =>
          client
            .prepare(`UPDATE workspace SET runtime_key_id = ?, runtime_key = ?${ctx.credential === undefined ? ", runtime_key_generation = runtime_key_generation + 1" : ""}
          WHERE id = ? AND ${ctx.previousKeyId === undefined ? "runtime_key_id IS NULL" : "runtime_key_id = ?"}`)
            .run(
              ...values,
              ...(ctx.previousKeyId === undefined ? [] : [ctx.previousKeyId]),
            ),
        catch: (cause) =>
          new WorkspaceServiceError({ detail: "assign workspace key", cause }),
      });
    }
    return await client
      .query(
        `UPDATE workspace SET runtime_key_id = $1, runtime_key = $2${ctx.credential === undefined ? ", runtime_key_generation = runtime_key_generation + 1" : ""}
      WHERE id = $3 AND ${ctx.previousKeyId === undefined ? "runtime_key_id IS NULL" : "runtime_key_id = $4"}`,
        [
          ...values,
          ...(ctx.previousKeyId === undefined ? [] : [ctx.previousKeyId]),
        ],
      )
      .catch(
        (cause) =>
          new WorkspaceServiceError({ detail: "assign workspace key", cause }),
      );
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

  /** Activity from a due schedule wakes the VM before dispatching its routine. */
  async wakeForRoutine(workspaceId: string) {
    const client = this.db.client;
    const owner =
      client instanceof DatabaseSync
        ? errore.try({
            // SAFETY: The projection selects only workspace.user_id.
            try: () =>
              client
                .prepare("SELECT user_id FROM workspace WHERE id = ?")
                .get(workspaceId) as { user_id: string } | undefined,
            catch: (cause) =>
              new WorkspaceServiceError({
                detail: "find routine workspace",
                cause,
              }),
          })
        : await client
            .query<{ user_id: string }>(
              "SELECT user_id FROM workspace WHERE id = $1",
              [workspaceId],
            )
            .then((selected) => selected.rows[0])
            .catch(
              (cause) =>
                new WorkspaceServiceError({
                  detail: "find routine workspace",
                  cause,
                }),
            );
    if (owner instanceof Error) return owner;
    if (owner === undefined)
      return new WorkspaceServiceError({ detail: "find routine workspace" });
    const activity = await this.recordActivity(owner.user_id);
    if (activity instanceof Error) return activity;
    const input = { workspaceId, ownerUserId: owner.user_id };
    const status = await this.provider.getStatus?.(input);
    if (status instanceof Error) return status;
    if (status === "paused") {
      const resumed = await this.provider.resume?.(input);
      if (resumed instanceof Error) return resumed;
    }
    return await this.provider.getConnection(input);
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
              `SELECT id, created_at, runtime_key_id, runtime_key, runtime_key_generation, activity_at
               FROM workspace
               WHERE user_id = ?`,
            )
            .get(userId) as SqliteWorkspaceRow | undefined;

          if (row === undefined) return undefined;
          return {
            id: row.id,
            createdAt: new Date(row.created_at),
            runtimeKeyGeneration: row.runtime_key_generation,
            activityAt: row.activity_at,
            runtimeCredential:
              row.runtime_key_id === null || row.runtime_key === null
                ? undefined
                : { keyId: row.runtime_key_id, encryptedKey: row.runtime_key },
          } satisfies Workspace;
        },
        catch: (cause) =>
          new WorkspaceServiceError({ detail: "load workspace", cause }),
      });
    }

    const selected = await client
      .query<PostgresWorkspaceRow>(
        `SELECT id, created_at, runtime_key_id, runtime_key, runtime_key_generation, activity_at
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
    return {
      id: row.id,
      createdAt: row.created_at,
      runtimeKeyGeneration: row.runtime_key_generation,
      activityAt: Number(row.activity_at),
      runtimeCredential:
        row.runtime_key_id === null || row.runtime_key === null
          ? undefined
          : { keyId: row.runtime_key_id, encryptedKey: row.runtime_key },
    } satisfies Workspace;
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
        try: () => {
          client.exec(`CREATE TABLE IF NOT EXISTS workspace (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL
          )`);
          const activityColumns = client
            .prepare("PRAGMA table_info(workspace)")
            .all();
          if (!activityColumns.some((column) => column.name === "activity_at"))
            client.exec(
              "ALTER TABLE workspace ADD COLUMN activity_at BIGINT NOT NULL DEFAULT 0",
            );
          // Existing workspace identities and files survive the new auth columns.
          const columns = client.prepare("PRAGMA table_info(workspace)").all();
          for (const name of ["runtime_key_id", "runtime_key"]) {
            if (!columns.some((column) => column.name === name))
              client.exec(`ALTER TABLE workspace ADD COLUMN ${name} TEXT`);
          }
          if (
            !columns.some((column) => column.name === "runtime_key_generation")
          )
            client.exec(
              "ALTER TABLE workspace ADD COLUMN runtime_key_generation INTEGER NOT NULL DEFAULT 1",
            );
        },
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
      );
      ALTER TABLE workspace ADD COLUMN IF NOT EXISTS activity_at BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE workspace ADD COLUMN IF NOT EXISTS runtime_key_id TEXT;
      ALTER TABLE workspace ADD COLUMN IF NOT EXISTS runtime_key TEXT;
      ALTER TABLE workspace ADD COLUMN IF NOT EXISTS runtime_key_generation INTEGER NOT NULL DEFAULT 1;`)
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
