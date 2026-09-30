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
      const rows = connection
        .prepare(
          `SELECT id, user_id, label, accelerator, action, position FROM halo_hotkeys${where} ORDER BY tuple_key ${direction}${limit}`,
        )
        .all(...bindings) as HotkeyRow[];
      return rows.map((row) => ({
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
    });
  }

  async commit(writes: WriteOps<TandemTuple<WorkspaceSchema>>): Promise<void> {
    await this.access((connection) =>
      connection.transaction(() => {
        const set = connection.prepare(
          `INSERT INTO halo_hotkeys (tuple_key, id, user_id, label, accelerator, action, position)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tuple_key) DO UPDATE SET
             id = excluded.id, user_id = excluded.user_id, label = excluded.label,
             accelerator = excluded.accelerator, action = excluded.action, position = excluded.position`,
        );
        const remove = connection.prepare(
          "DELETE FROM halo_hotkeys WHERE tuple_key = ?",
        );
        // Match Tandem's in-memory/JSON storage: sets win if a batch also removes a key.
        for (const key of writes.remove ?? []) remove.run(encodeKey(key));
        for (const { key, value } of writes.set ?? [])
          set.run(
            encodeKey(key),
            value.id,
            value.userId,
            value.label,
            value.accelerator,
            JSON.stringify(value.action),
            value.position,
          );
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
