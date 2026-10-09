import { DatabaseSync } from "node:sqlite";
import { createHaloClient } from "@get-halo/client";
import { GoogleAuth } from "google-auth-library";
import * as errore from "errore";
import type { PoolClient } from "pg";
import type { DatabaseService } from "../DatabaseService.js";
import type { WorkspaceService } from "./WorkspaceService.js";
import type { WorkspaceProviderConnection } from "./provider/WorkspaceProviderApi.js";

const pollMs = 15_000;
const retryMs = 30_000;
const batchSize = 20;

type AutomationScheduleSnapshot = {
  automations: Array<{ id: string; nextRunAt: string }>;
};

type DueRoutine = { workspaceId: string; routineId: string };

class AutomationScheduleCoordinatorError extends errore.createTaggedError({
  name: "AutomationScheduleCoordinatorError",
  message: "Routine coordination failed: $detail",
}) {}

export class AutomationScheduleCoordinator {
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private closed = false;
  private readonly db: DatabaseService;
  private readonly workspace: WorkspaceService;
  private readonly auth = new GoogleAuth();

  private constructor(ctx: {
    db: DatabaseService;
    workspace: WorkspaceService;
  }) {
    this.db = ctx.db;
    this.workspace = ctx.workspace;
  }

  static async start(ctx: {
    db: DatabaseService;
    workspace: WorkspaceService;
  }) {
    const coordinator = new AutomationScheduleCoordinator(ctx);
    const migrated = await coordinator.migrate();
    if (migrated instanceof Error) return migrated;
    coordinator.timer = setInterval(() => coordinator.scheduleTick(), pollMs);
    coordinator.timer.unref();
    coordinator.scheduleTick();
    return coordinator;
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.ticking;
  }

  async update(workspaceId: string, snapshot: AutomationScheduleSnapshot) {
    const db = this.db.client;
    if (db instanceof DatabaseSync) {
      const updated = sqliteTransaction(db, () => {
        const ids = snapshot.automations.map((routine) => routine.id);
        if (ids.length === 0)
          db.prepare(
            "DELETE FROM workspace_routine_schedule WHERE workspace_id = ?",
          ).run(workspaceId);
        else
          db.prepare(
            `DELETE FROM workspace_routine_schedule WHERE workspace_id = ? AND routine_id NOT IN (${ids.map(() => "?").join(",")})`,
          ).run(workspaceId, ...ids);
        const insert = db.prepare(`INSERT INTO workspace_routine_schedule
            (workspace_id, routine_id, next_run_at, last_attempt_at)
            VALUES (?, ?, ?, NULL)
            ON CONFLICT (workspace_id, routine_id) DO UPDATE SET
              next_run_at = excluded.next_run_at,
              last_attempt_at = CASE WHEN next_run_at = excluded.next_run_at
                THEN last_attempt_at ELSE NULL END`);
        for (const routine of snapshot.automations)
          insert.run(workspaceId, routine.id, Date.parse(routine.nextRunAt));
      });
      if (updated instanceof Error) return updated;
      this.scheduleTick();
      return;
    }

    const connection = await db.connect().catch(
      (cause) =>
        new AutomationScheduleCoordinatorError({
          detail: "connect for snapshot",
          cause,
        }),
    );
    if (connection instanceof Error) return connection;
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => connection.release());
    const begun = await connection.query("BEGIN").catch(
      (cause) =>
        new AutomationScheduleCoordinatorError({
          detail: "begin snapshot",
          cause,
        }),
    );
    if (begun instanceof Error) return begun;
    const ids = snapshot.automations.map((routine) => routine.id);
    const removed = await connection
      .query(
        "DELETE FROM workspace_routine_schedule WHERE workspace_id = $1 AND routine_id <> ALL($2::text[])",
        [workspaceId, ids],
      )
      .catch(
        (cause) =>
          new AutomationScheduleCoordinatorError({
            detail: "replace schedules",
            cause,
          }),
      );
    if (removed instanceof Error) {
      await this.rollback(connection);
      return removed;
    }
    for (const routine of snapshot.automations) {
      const inserted = await connection
        .query(
          `INSERT INTO workspace_routine_schedule
        (workspace_id, routine_id, next_run_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (workspace_id, routine_id) DO UPDATE SET
          next_run_at = EXCLUDED.next_run_at,
          last_attempt_at = CASE WHEN workspace_routine_schedule.next_run_at = EXCLUDED.next_run_at
            THEN workspace_routine_schedule.last_attempt_at ELSE NULL END`,
          [workspaceId, routine.id, Date.parse(routine.nextRunAt)],
        )
        .catch(
          (cause) =>
            new AutomationScheduleCoordinatorError({
              detail: "store schedule",
              cause,
            }),
        );
      if (inserted instanceof Error) {
        await this.rollback(connection);
        return inserted;
      }
    }
    const committed = await connection.query("COMMIT").catch(
      (cause) =>
        new AutomationScheduleCoordinatorError({
          detail: "commit snapshot",
          cause,
        }),
    );
    if (committed instanceof Error) {
      await this.rollback(connection);
      return committed;
    }
    this.scheduleTick();
  }

  private async rollback(connection: PoolClient) {
    const rolledBack = await connection.query("ROLLBACK").catch(
      (cause) =>
        new AutomationScheduleCoordinatorError({
          detail: "roll back snapshot",
          cause,
        }),
    );
    if (rolledBack instanceof Error) console.error(rolledBack);
  }

  private scheduleTick() {
    if (this.closed || this.ticking !== undefined) return;
    this.ticking = this.tick().then(() => {
      this.ticking = undefined;
    });
  }

  private async tick() {
    const due = await this.claimDue();
    if (due instanceof Error) {
      console.error(due);
      return;
    }
    const grouped = new Map<string, string[]>();
    for (const row of due) {
      const routineIds = grouped.get(row.workspaceId) ?? [];
      routineIds.push(row.routineId);
      grouped.set(row.workspaceId, routineIds);
    }
    await Promise.all(
      [...grouped].map(
        async ([workspaceId, routineIds]) =>
          await this.fire(workspaceId, routineIds),
      ),
    );
  }

  private async claimDue(): Promise<DueRoutine[] | Error> {
    const db = this.db.client;
    const now = Date.now();
    if (db instanceof DatabaseSync)
      return sqliteTransaction(db, () => {
        // SAFETY: The projection matches workspace_routine_schedule columns.
        const rows = db
          .prepare(`SELECT workspace_id, routine_id FROM workspace_routine_schedule
            WHERE next_run_at <= ? AND (last_attempt_at IS NULL OR last_attempt_at <= ?)
            ORDER BY next_run_at LIMIT ?`)
          .all(now, now - retryMs, batchSize) as Array<{
          workspace_id: string;
          routine_id: string;
        }>;
        const claim =
          db.prepare(`UPDATE workspace_routine_schedule SET last_attempt_at = ?
            WHERE workspace_id = ? AND routine_id = ?`);
        for (const row of rows)
          claim.run(now, row.workspace_id, row.routine_id);
        return rows.map((row) => ({
          workspaceId: row.workspace_id,
          routineId: row.routine_id,
        }));
      });
    const claimed = await db
      .query<{ workspace_id: string; routine_id: string }>(
        `
      WITH due AS (
        SELECT workspace_id, routine_id FROM workspace_routine_schedule
        WHERE next_run_at <= $1 AND (last_attempt_at IS NULL OR last_attempt_at <= $2)
        ORDER BY next_run_at LIMIT $3 FOR UPDATE SKIP LOCKED
      )
      UPDATE workspace_routine_schedule AS schedule SET last_attempt_at = $1
      FROM due WHERE schedule.workspace_id = due.workspace_id AND schedule.routine_id = due.routine_id
      RETURNING schedule.workspace_id, schedule.routine_id`,
        [now, now - retryMs, batchSize],
      )
      .catch(
        (cause) =>
          new AutomationScheduleCoordinatorError({
            detail: "claim due routines",
            cause,
          }),
      );
    if (claimed instanceof Error) return claimed;
    return claimed.rows.map((row) => ({
      workspaceId: row.workspace_id,
      routineId: row.routine_id,
    }));
  }

  private async fire(workspaceId: string, routineIds: string[]) {
    const connection = await this.workspace.wakeForAutomation(workspaceId);
    if (connection instanceof Error) {
      console.error(connection);
      return;
    }
    if (connection === undefined) return;
    const headers = await this.authorization(connection);
    if (headers instanceof Error) {
      console.error(headers);
      return;
    }
    const client = createHaloClient({
      transport: { origin: connection.origin, path: "/rpc", headers },
    });
    await Promise.all(
      routineIds.map(async (routineId) => {
        const started = await client.automations
          .runScheduled(
            { automationId: routineId },
            { signal: AbortSignal.timeout(20_000) },
          )
          .catch(
            (cause) =>
              new AutomationScheduleCoordinatorError({
                detail: "start due routine",
                cause,
              }),
          );
        if (started instanceof Error) console.error(started);
      }),
    );
  }

  private async authorization(connection: WorkspaceProviderConnection) {
    if (connection.authorization.type === "headers")
      return { ...connection.authorization.value };
    if (connection.authorization.type === "bearer")
      return { authorization: connection.authorization.value };
    const client = await this.auth.getIdTokenClient(connection.origin).catch(
      (cause) =>
        new AutomationScheduleCoordinatorError({
          detail: "create identity client",
          cause,
        }),
    );
    if (client instanceof Error) return client;
    const headers = await client.getRequestHeaders().catch(
      (cause) =>
        new AutomationScheduleCoordinatorError({
          detail: "authorize VM request",
          cause,
        }),
    );
    if (headers instanceof Error) return headers;
    const authorization = headers.get("authorization");
    if (authorization === null)
      return new AutomationScheduleCoordinatorError({
        detail: "identity token missing",
      });
    return { authorization };
  }

  private async migrate() {
    const db = this.db.client;
    if (db instanceof DatabaseSync)
      return errore.try({
        try: () =>
          db.exec(`CREATE TABLE IF NOT EXISTS workspace_routine_schedule (
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          routine_id TEXT NOT NULL,
          next_run_at BIGINT NOT NULL,
          last_attempt_at BIGINT,
          PRIMARY KEY (workspace_id, routine_id)
        );
        CREATE INDEX IF NOT EXISTS workspace_routine_due ON workspace_routine_schedule(next_run_at);`),
        catch: (cause) =>
          new AutomationScheduleCoordinatorError({
            detail: "migrate SQLite schedules",
            cause,
          }),
      });
    return await db
      .query(`CREATE TABLE IF NOT EXISTS workspace_routine_schedule (
      workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
      routine_id TEXT NOT NULL,
      next_run_at BIGINT NOT NULL,
      last_attempt_at BIGINT,
      PRIMARY KEY (workspace_id, routine_id)
    );
    CREATE INDEX IF NOT EXISTS workspace_routine_due ON workspace_routine_schedule(next_run_at);`)
      .then(() => undefined)
      .catch(
        (cause) =>
          new AutomationScheduleCoordinatorError({
            detail: "migrate PostgreSQL schedules",
            cause,
          }),
      );
  }
}

function sqliteTransaction<T>(db: DatabaseSync, work: () => T): T | Error {
  const begun = errore.try({
    try: () => db.exec("BEGIN IMMEDIATE"),
    catch: (cause) =>
      new AutomationScheduleCoordinatorError({
        detail: "begin SQLite transaction",
        cause,
      }),
  });
  if (begun instanceof Error) return begun;
  const result = errore.try({
    try: () => {
      const value = work();
      db.exec("COMMIT");
      return value;
    },
    catch: (cause) =>
      new AutomationScheduleCoordinatorError({
        detail: "write SQLite schedules",
        cause,
      }),
  });
  if (!(result instanceof Error)) return result;
  const rolledBack = errore.try({
    try: () => db.exec("ROLLBACK"),
    catch: (cause) =>
      new AutomationScheduleCoordinatorError({
        detail: "roll back SQLite schedules",
        cause,
      }),
  });
  if (rolledBack instanceof Error) console.error(rolledBack);
  return result;
}
