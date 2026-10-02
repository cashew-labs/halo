import { DatabaseSync } from "node:sqlite";
import {
  createHaloClient,
  type RoutineScheduleSnapshot,
} from "@get-halo/client";
import { GoogleAuth } from "google-auth-library";
import * as errore from "errore";
import type { Pool, PoolClient } from "pg";
import type { DatabaseService } from "../DatabaseService.js";
import type { WorkspaceService } from "./WorkspaceService.js";

const pollMs = 15_000;
const idleMs = 30 * 60_000;

class RoutineCoordinatorError extends errore.createTaggedError({
  name: "RoutineCoordinatorError",
  message: "Workspace routine coordination failed: $detail",
}) {}

type DueRow = { workspace_id: string; routine_id: string };
type IdleRow = { workspace_id: string };

export class RoutineCoordinator {
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private closed = false;
  private readonly database: Pool;
  private readonly workspace: WorkspaceService;
  private readonly auth = new GoogleAuth();

  private constructor(ctx: { database: Pool; workspace: WorkspaceService }) {
    this.database = ctx.database;
    this.workspace = ctx.workspace;
  }

  static async start(ctx: {
    db: DatabaseService;
    workspace: WorkspaceService;
  }) {
    if (ctx.db.client instanceof DatabaseSync)
      return new RoutineCoordinatorError({
        detail: "open production database",
      });
    const database = ctx.db.client;
    const migrated = await database
      .query(`
        CREATE TABLE IF NOT EXISTS workspace_routine_schedule (
          workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          routine_id TEXT NOT NULL,
          next_run_at TIMESTAMPTZ NOT NULL,
          last_attempt_at TIMESTAMPTZ,
          PRIMARY KEY (workspace_id, routine_id)
        );
        CREATE TABLE IF NOT EXISTS workspace_routine_state (
          workspace_id UUID PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
          busy BOOLEAN NOT NULL,
          last_report_at TIMESTAMPTZ NOT NULL,
          last_sleep_at TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS workspace_routine_due
          ON workspace_routine_schedule(next_run_at);
      `)
      .catch(
        (cause) =>
          new RoutineCoordinatorError({ detail: "migrate schedules", cause }),
      );
    if (migrated instanceof Error) return migrated;
    const coordinator = new RoutineCoordinator({
      database,
      workspace: ctx.workspace,
    });
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

  async update(workspaceId: string, snapshot: RoutineScheduleSnapshot) {
    const connection = await this.database.connect().catch(
      (cause) =>
        new RoutineCoordinatorError({
          detail: "connect for snapshot",
          cause,
        }),
    );
    if (connection instanceof Error) return connection;
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => connection.release());
    const begun = await connection
      .query("BEGIN")
      .catch(
        (cause) =>
          new RoutineCoordinatorError({ detail: "begin snapshot", cause }),
      );
    if (begun instanceof Error) return begun;
    const updated = await connection
      .query(
        `WITH previous AS (
           SELECT busy FROM workspace_routine_state WHERE workspace_id = $1
         ), state AS (
           INSERT INTO workspace_routine_state (workspace_id, busy, last_report_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (workspace_id) DO UPDATE
             SET busy = EXCLUDED.busy, last_report_at = EXCLUDED.last_report_at
         )
         UPDATE workspace SET last_activity_at = NOW()
         WHERE id = $1 AND ($2 OR EXISTS (SELECT 1 FROM previous WHERE busy))`,
        [workspaceId, snapshot.busy],
      )
      .catch(
        (cause) =>
          new RoutineCoordinatorError({
            detail: "update workspace activity",
            cause,
          }),
      );
    if (updated instanceof Error) {
      await this.rollback(connection);
      return updated;
    }
    const activeRoutineIds = snapshot.routines
      .filter((routine) => routine.nextRunAt !== undefined)
      .map((routine) => routine.id);
    const removed = await connection
      .query(
        `DELETE FROM workspace_routine_schedule
         WHERE workspace_id = $1 AND routine_id <> ALL($2::text[])`,
        [workspaceId, activeRoutineIds],
      )
      .catch(
        (cause) =>
          new RoutineCoordinatorError({ detail: "replace schedules", cause }),
      );
    if (removed instanceof Error) {
      await this.rollback(connection);
      return removed;
    }
    for (const routine of snapshot.routines) {
      if (routine.nextRunAt === undefined) continue;
      const inserted = await connection
        .query(
          `INSERT INTO workspace_routine_schedule
             (workspace_id, routine_id, next_run_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (workspace_id, routine_id) DO UPDATE
             SET next_run_at = EXCLUDED.next_run_at,
                 last_attempt_at = CASE
                   WHEN workspace_routine_schedule.next_run_at = EXCLUDED.next_run_at
                     THEN workspace_routine_schedule.last_attempt_at
                   ELSE NULL
                 END`,
          [workspaceId, routine.id, routine.nextRunAt],
        )
        .catch(
          (cause) =>
            new RoutineCoordinatorError({ detail: "store schedule", cause }),
        );
      if (inserted instanceof Error) {
        await this.rollback(connection);
        return inserted;
      }
    }
    const committed = await connection
      .query("COMMIT")
      .catch(
        (cause) =>
          new RoutineCoordinatorError({ detail: "commit snapshot", cause }),
      );
    if (committed instanceof Error) {
      await this.rollback(connection);
      return committed;
    }
    this.scheduleTick();
  }

  private async rollback(connection: PoolClient) {
    const rolledBack = await connection
      .query("ROLLBACK")
      .catch(
        (cause) =>
          new RoutineCoordinatorError({ detail: "roll back snapshot", cause }),
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
    const due = await this.database
      .query<DueRow>(
        `SELECT workspace_id, routine_id FROM workspace_routine_schedule
         WHERE next_run_at <= NOW()
           AND (
             last_attempt_at IS NULL OR
             last_attempt_at < NOW() - INTERVAL '30 seconds'
           )
         ORDER BY next_run_at LIMIT 20`,
      )
      .catch(
        (cause) =>
          new RoutineCoordinatorError({ detail: "load due routines", cause }),
      );
    if (due instanceof Error) {
      console.error(due);
      return;
    }
    const grouped = new Map<string, string[]>();
    for (const row of due.rows) {
      const claimed = await this.database
        .query(
          `UPDATE workspace_routine_schedule SET last_attempt_at = NOW()
           WHERE workspace_id = $1 AND routine_id = $2
             AND (
               last_attempt_at IS NULL OR
               last_attempt_at < NOW() - INTERVAL '30 seconds'
             )`,
          [row.workspace_id, row.routine_id],
        )
        .catch(
          (cause) =>
            new RoutineCoordinatorError({
              detail: "claim due routine",
              cause,
            }),
        );
      if (claimed instanceof Error) {
        console.error(claimed);
        continue;
      }
      if (claimed.rowCount === 0) continue;
      const routineIds = grouped.get(row.workspace_id) ?? [];
      routineIds.push(row.routine_id);
      grouped.set(row.workspace_id, routineIds);
    }
    await Promise.all(
      [...grouped].map(
        async ([workspaceId, routineIds]) =>
          await this.fire(workspaceId, routineIds),
      ),
    );
    const idle = await this.database
      .query<IdleRow>(
        `SELECT workspace.id AS workspace_id
         FROM workspace JOIN workspace_routine_state AS state
           ON state.workspace_id = workspace.id
         WHERE workspace.last_activity_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
           AND state.busy = false
           AND state.last_report_at > NOW() - INTERVAL '2 minutes'
           AND (
             state.last_sleep_at IS NULL OR
             state.last_sleep_at < workspace.last_activity_at OR
             state.last_sleep_at < NOW() - INTERVAL '1 hour'
           )
           AND NOT EXISTS (
             SELECT 1 FROM workspace_routine_schedule AS due
             WHERE due.workspace_id = workspace.id AND due.next_run_at <= NOW()
           )
         LIMIT 20`,
        [idleMs],
      )
      .catch(
        (cause) =>
          new RoutineCoordinatorError({
            detail: "load idle workspaces",
            cause,
          }),
      );
    if (idle instanceof Error) {
      console.error(idle);
      return;
    }
    for (const row of idle.rows) {
      if (this.workspace.hasActiveRequests(row.workspace_id)) continue;
      const recorded = await this.database
        .query(
          `UPDATE workspace_routine_state AS state SET last_sleep_at = NOW()
           WHERE workspace_id = $1 AND busy = false
             AND last_report_at > NOW() - INTERVAL '2 minutes'
             AND EXISTS (
               SELECT 1 FROM workspace
               WHERE id = state.workspace_id
                 AND last_activity_at < NOW() - ($2::bigint * INTERVAL '1 millisecond')
                 AND NOT EXISTS (
                   SELECT 1 FROM workspace_routine_schedule AS due
                   WHERE due.workspace_id = workspace.id AND due.next_run_at <= NOW()
                 )
             )
             AND (
               last_sleep_at IS NULL OR
               last_sleep_at < NOW() - INTERVAL '1 hour' OR
               last_sleep_at < (
                 SELECT last_activity_at FROM workspace WHERE id = state.workspace_id
               )
             )`,
          [row.workspace_id, idleMs],
        )
        .catch(
          (cause) =>
            new RoutineCoordinatorError({
              detail: "record workspace sleep",
              cause,
            }),
        );
      if (recorded instanceof Error) {
        console.error(recorded);
        continue;
      }
      if (recorded.rowCount === 0) continue;
      if (this.workspace.hasActiveRequests(row.workspace_id)) continue;
      this.workspace.sleep(row.workspace_id);
    }
  }

  private async fire(workspaceId: string, routineIds: string[]) {
    const workspace = await this.workspace.wake(workspaceId);
    if (workspace instanceof Error) {
      console.error(workspace);
      return;
    }
    if (workspace.status !== "running") return;
    const origin = this.workspace.connectionForId(workspaceId);
    if (origin === undefined) return;
    const identity = await this.auth.getIdTokenClient(origin).catch(
      (cause) =>
        new RoutineCoordinatorError({
          detail: "authenticate VM request",
          cause,
        }),
    );
    if (identity instanceof Error) {
      console.error(identity);
      return;
    }
    const headers = await identity.getRequestHeaders().catch(
      (cause) =>
        new RoutineCoordinatorError({
          detail: "authorize VM request",
          cause,
        }),
    );
    if (headers instanceof Error) {
      console.error(headers);
      return;
    }
    const authorization = headers.get("authorization");
    if (authorization === null) return;
    const client = createHaloClient({
      transport: {
        origin,
        path: "/rpc",
        headers: { authorization },
      },
    });
    await Promise.all(
      routineIds.map(async (routineId) => {
        const started = await client.routines
          .runScheduled({ routineId }, { signal: AbortSignal.timeout(20_000) })
          .catch(
            (cause) =>
              new RoutineCoordinatorError({
                detail: "start due routine",
                cause,
              }),
          );
        if (started instanceof Error) console.error(started);
      }),
    );
  }
}
