// oxlint-disable unicorn/no-null -- SQL rows and bindings use null for NULL.
import type {
  TandemServerStorageApi,
  TandemTuple,
} from "@tanishqkancharla/tandem-server";
import type { Database } from "@tursodatabase/database/compat";
import * as errore from "errore";
import type { ScanStorageArgs, Tuple, WriteOps } from "tuple-database";
import { encodeTuple } from "tuple-database/helpers/codec.js";
import type { NativeConnection, WorkspaceSchema } from "./DatabaseService.js";

type HotkeyRow = {
  id: string;
  user_id: string;
  label: string;
  accelerator: string;
  action: string;
  position: number;
};

type RoutineRow = {
  id: string;
  extension_id: string | null;
  name: string;
  cron: string;
  timezone: string;
  action: string;
  enabled: number;
  auto_archive_session: number;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
  last_run_id: string | null;
  run_sequence: number;
};

type RoutineRunRow = {
  id: string;
  routine_id: string;
  trigger: WorkspaceSchema["routineRuns"]["trigger"];
  scheduled_for: string;
  session_id: string | null;
  status: WorkspaceSchema["routineRuns"]["status"];
  started_at: string;
  finished_at: string | null;
  error: string | null;
  sequence: number;
};

const tables = {
  hotkeys: "halo_hotkeys",
  routines: "halo_routine_definitions",
  routineRuns: "halo_routine_history",
} satisfies Record<keyof WorkspaceSchema, string>;

class TupleStorageClosedError extends errore.createTaggedError({
  name: "TupleStorageClosedError",
  message: "Tandem tuple storage is closed",
}) {}

export class TursoTupleStorage implements TandemServerStorageApi<WorkspaceSchema> {
  // Closing this borrower rejects new operations, then drains queued database work.
  private closed = false;
  private readonly database: NativeConnection;

  constructor(ctx: { database: NativeConnection }) {
    const { database } = ctx;
    this.database = database;
  }

  async scan(
    args: ScanStorageArgs = {},
  ): Promise<TandemTuple<WorkspaceSchema>[]> {
    return await this.access((connection) => {
      const predicates: string[] = [];
      const bindings: (Buffer | number)[] = [];
      for (const [bound, operator] of [
        ["gt", ">"],
        ["gte", ">="],
        ["lt", "<"],
        ["lte", "<="],
      ] as const) {
        const tuple = args[bound];
        if (tuple === undefined) continue;
        predicates.push(`tuple_key ${operator} ?`);
        bindings.push(encodeKey(tuple));
      }
      const direction = args.reverse === true ? "DESC" : "ASC";
      const limit = args.limit === undefined ? "" : " LIMIT ?";
      if (args.limit !== undefined) bindings.push(args.limit);
      const where =
        predicates.length === 0 ? "" : ` WHERE ${predicates.join(" AND ")}`;
      // SAFETY: The projection matches halo_hotkeys. The key index preserves
      // arbitrary tuple bounds; domain fields live in columns, not opaque tuples.
      const hotkeys = connection
        .prepare(
          `SELECT id, user_id, label, accelerator, action, position FROM halo_hotkeys${where} ORDER BY tuple_key ${direction}${limit}`,
        )
        .all(...bindings) as HotkeyRow[];
      const rows: TandemTuple<WorkspaceSchema>[] = hotkeys.map((row) => ({
        key: ["record", "hotkeys", row.id],
        value: {
          id: row.id,
          userId: row.user_id,
          label: row.label,
          accelerator: row.accelerator,
          // SAFETY: Actions are written from the typed workspace schema below.
          action: JSON.parse(
            row.action,
          ) as WorkspaceSchema["hotkeys"]["action"],
          position: row.position,
        },
      }));
      // Each table can contribute at most the global limit. Merge by tuple key,
      // not table order, before applying that limit across collections.
      const suffix = `${where} ORDER BY tuple_key ${direction}${limit}`;
      // SAFETY: These projections match the domain-table migration.
      const routines = connection
        .prepare(`SELECT * FROM halo_routine_definitions${suffix}`)
        .all(...bindings) as RoutineRow[];
      for (const row of routines)
        rows.push({
          key: ["record", "routines", row.id],
          value: {
            id: row.id,
            extensionId: row.extension_id ?? undefined,
            name: row.name,
            cron: row.cron,
            timezone: row.timezone,
            // SAFETY: Written from the typed routine action below.
            action: JSON.parse(
              row.action,
            ) as WorkspaceSchema["routines"]["action"],
            enabled: row.enabled === 1,
            autoArchiveSession: row.auto_archive_session === 1,
            nextRunAt: row.next_run_at ?? undefined,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            lastRunId: row.last_run_id ?? undefined,
            runSequence: row.run_sequence,
          },
        });
      // SAFETY: The projection matches halo_routine_history.
      const runs = connection
        .prepare(`SELECT * FROM halo_routine_history${suffix}`)
        .all(...bindings) as RoutineRunRow[];
      for (const row of runs)
        rows.push({
          key: ["record", "routineRuns", row.id],
          value: {
            id: row.id,
            routineId: row.routine_id,
            trigger: row.trigger,
            scheduledFor: row.scheduled_for,
            sessionId: row.session_id ?? undefined,
            status: row.status,
            startedAt: row.started_at,
            finishedAt: row.finished_at ?? undefined,
            error: row.error ?? undefined,
            sequence: row.sequence,
          },
        });
      rows.sort(
        (a, b) =>
          Buffer.compare(encodeKey(a.key), encodeKey(b.key)) *
          (args.reverse === true ? -1 : 1),
      );
      return args.limit === undefined || args.limit < 0
        ? rows
        : rows.slice(0, args.limit);
    });
  }

  async commit(writes: WriteOps<TandemTuple<WorkspaceSchema>>): Promise<void> {
    await this.access((connection) =>
      connection.transaction(() => {
        const setHotkey = connection.prepare(
          `INSERT INTO halo_hotkeys (tuple_key, id, user_id, label, accelerator, action, position)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tuple_key) DO UPDATE SET
             id = excluded.id, user_id = excluded.user_id, label = excluded.label,
             accelerator = excluded.accelerator, action = excluded.action, position = excluded.position`,
        );
        const setRoutine = connection.prepare(
          `INSERT INTO halo_routine_definitions
            (tuple_key, id, extension_id, name, cron, timezone, action, enabled, auto_archive_session,
             next_run_at, created_at, updated_at, last_run_id, run_sequence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tuple_key) DO UPDATE SET
             extension_id = excluded.extension_id, name = excluded.name, cron = excluded.cron,
             timezone = excluded.timezone, action = excluded.action, enabled = excluded.enabled,
             auto_archive_session = excluded.auto_archive_session, next_run_at = excluded.next_run_at,
             created_at = excluded.created_at, updated_at = excluded.updated_at,
             last_run_id = excluded.last_run_id, run_sequence = excluded.run_sequence`,
        );
        const setRun = connection.prepare(
          `INSERT INTO halo_routine_history
            (tuple_key, id, routine_id, trigger, scheduled_for, session_id, status, started_at, finished_at, error, sequence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tuple_key) DO UPDATE SET
             routine_id = excluded.routine_id, trigger = excluded.trigger, scheduled_for = excluded.scheduled_for,
             session_id = excluded.session_id, status = excluded.status, started_at = excluded.started_at,
             finished_at = excluded.finished_at, error = excluded.error, sequence = excluded.sequence`,
        );
        // Match Tandem's in-memory/JSON storage: sets win if a batch also removes a key.
        for (const key of writes.remove ?? [])
          connection
            .prepare(`DELETE FROM ${tables[key[1]]} WHERE tuple_key = ?`)
            .run(encodeKey(key));
        for (const { key, value: record } of writes.set ?? []) {
          if (key[1] === "routines") {
            // SAFETY: TandemTuple pairs the checked collection key with its record type.
            const value = record as WorkspaceSchema["routines"];
            setRoutine.run(
              encodeKey(key),
              value.id,
              value.extensionId ?? null,
              value.name,
              value.cron,
              value.timezone,
              JSON.stringify(value.action),
              value.enabled ? 1 : 0,
              value.autoArchiveSession ? 1 : 0,
              value.nextRunAt ?? null,
              value.createdAt,
              value.updatedAt,
              value.lastRunId ?? null,
              value.runSequence,
            );
            continue;
          }
          if (key[1] === "routineRuns") {
            // SAFETY: TandemTuple pairs the checked collection key with its record type.
            const value = record as WorkspaceSchema["routineRuns"];
            setRun.run(
              encodeKey(key),
              value.id,
              value.routineId,
              value.trigger,
              value.scheduledFor,
              value.sessionId ?? null,
              value.status,
              value.startedAt,
              value.finishedAt ?? null,
              value.error ?? null,
              value.sequence,
            );
            continue;
          }
          // SAFETY: The remaining TandemTuple collection is hotkeys.
          const value = record as WorkspaceSchema["hotkeys"];
          setHotkey.run(
            encodeKey(key),
            value.id,
            value.userId,
            value.label,
            value.accelerator,
            JSON.stringify(value.action),
            value.position,
          );
        }
      })(),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    // DatabaseService owns the connection; a Tandem server only closes its borrower.
    const drained = await this.database.access(() => undefined);
    if (drained instanceof Error) throw drained;
  }

  private async access<T>(operation: (connection: Database) => T): Promise<T> {
    if (this.closed) throw new TupleStorageClosedError();
    const result = await this.database.access(operation);
    // Tandem's storage interface requires rejected promises, not errors as values.
    if (result instanceof Error) throw result;
    return result;
  }
}

function encodeKey(tuple: Tuple) {
  // Tuple codec ordering uses JS UTF-16 code units. Big-endian BLOBs preserve
  // that order, including surrogate pairs, unlike SQL's UTF-8 TEXT ordering.
  return Buffer.from(encodeTuple(tuple), "utf16le").swap16();
}
