import type { AnySchema } from "@tanishqkancharla/tandem-core";
import type {
  TandemServerStorageApi,
  TandemTuple,
} from "@tanishqkancharla/tandem-server";
import type { Database } from "@tursodatabase/database/compat";
import * as errore from "errore";
import type { ScanStorageArgs, Tuple, WriteOps } from "tuple-database";
import { decodeTuple, encodeTuple } from "tuple-database/helpers/codec.js";
import type { NativeConnection } from "./DatabaseService.js";

class TupleStorageClosedError extends errore.createTaggedError({
  name: "TupleStorageClosedError",
  message: "Tandem tuple storage is closed",
}) {}

export class TursoTupleStorage<
  Schema extends AnySchema,
> implements TandemServerStorageApi<Schema> {
  // Closing this borrower rejects new operations, then drains queued database work.
  private closed = false;
  private readonly database: NativeConnection;
  private readonly namespace: string;

  constructor(ctx: { database: NativeConnection; namespace: string }) {
    const { database, namespace } = ctx;
    this.database = database;
    this.namespace = namespace;
  }

  async scan(args: ScanStorageArgs = {}): Promise<TandemTuple<Schema>[]> {
    return await this.access((connection) => {
      const predicates = ["namespace = ?"];
      const bindings: (string | Buffer | number)[] = [this.namespace];
      for (const [bound, operator] of [
        ["gt", ">"],
        ["gte", ">="],
        ["lt", "<"],
        ["lte", "<="],
      ] as const) {
        const tuple = args[bound];
        if (tuple === undefined) continue;
        predicates.push(`key ${operator} ?`);
        bindings.push(encodeKey(tuple));
      }
      const direction = args.reverse === true ? "DESC" : "ASC";
      const limit = args.limit === undefined ? "" : " LIMIT ?";
      if (args.limit !== undefined) bindings.push(args.limit);
      // SAFETY: The projection is owned by the Tandem tuple migration.
      const rows = connection
        .prepare(
          `SELECT key, value FROM halo_tandem_tuples WHERE ${predicates.join(" AND ")} ORDER BY key ${direction}${limit}`,
        )
        .all(...bindings) as { key: Uint8Array; value: string }[];
      // SAFETY: This namespace contains only tuples written through the typed storage API.
      return rows.map((row) => ({
        key: decodeTuple(Buffer.from(row.key).swap16().toString("utf16le")),
        value: JSON.parse(row.value),
      })) as TandemTuple<Schema>[];
    });
  }

  async commit(writes: WriteOps<TandemTuple<Schema>>): Promise<void> {
    await this.access((connection) =>
      connection.transaction(() => {
        const set = connection.prepare(
          `INSERT INTO halo_tandem_tuples (namespace, key, value) VALUES (?, ?, ?)
           ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value`,
        );
        const remove = connection.prepare(
          "DELETE FROM halo_tandem_tuples WHERE namespace = ? AND key = ?",
        );
        // Match Tandem's in-memory/JSON storage: sets win if a batch also removes a key.
        for (const key of writes.remove ?? [])
          remove.run(this.namespace, encodeKey(key));
        for (const { key, value } of writes.set ?? [])
          set.run(this.namespace, encodeKey(key), JSON.stringify(value));
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
