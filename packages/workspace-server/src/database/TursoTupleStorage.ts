import type {
  TandemServerStorageApi,
  TandemTuple,
} from "@tanishqkancharla/tandem-server";
import type { Database } from "@tursodatabase/database/compat";
import * as errore from "errore";
import type { ScanStorageArgs, Tuple, WriteOps } from "tuple-database";
import { encodeTuple } from "tuple-database/helpers/codec.js";
import type { NativeConnection } from "./DatabaseService.js";
import {
  haloSchemaToTursoTables,
  type Schema,
  type SchemaRecords,
  type SqlValue,
} from "@get-halo/schema";

class TupleStorageClosedError extends errore.createTaggedError({
  name: "TupleStorageClosedError",
  message: "Tandem tuple storage is closed",
}) {}

export class TursoTupleStorage<
  Definition extends Schema,
> implements TandemServerStorageApi<SchemaRecords<Definition>> {
  // Closing this borrower rejects new operations, then drains queued database work.
  private closed = false;
  private readonly tables: ReturnType<
    typeof haloSchemaToTursoTables<Definition>
  >;
  private readonly database: NativeConnection;

  constructor(ctx: { database: NativeConnection; schema: Definition }) {
    const { database, schema } = ctx;
    this.database = database;
    this.tables = haloSchemaToTursoTables(schema);
  }

  async scan(
    args: ScanStorageArgs = {},
  ): Promise<TandemTuple<SchemaRecords<Definition>>[]> {
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
      const suffix = `${where} ORDER BY tuple_key ${direction}${limit}`;
      const rows: TandemTuple<SchemaRecords<Definition>>[] = [];
      for (const [collection, table] of Object.entries(this.tables)) {
        // SAFETY: The generated projection selects the SQL values expected by its field decoders.
        const records = connection
          .prepare(table.select + suffix)
          .all(...bindings) as Record<string, SqlValue>[];
        for (const row of records) {
          const value = table.decode(row);
          // SAFETY: The registry pairs each collection with its own record decoder.
          rows.push({
            key: ["record", collection, value.id],
            value,
          } as TandemTuple<SchemaRecords<Definition>>);
        }
      }
      // Each table contributes at most the global limit; merge by tuple key before limiting.
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

  async commit(
    writes: WriteOps<TandemTuple<SchemaRecords<Definition>>>,
  ): Promise<void> {
    await this.access((connection) =>
      connection.transaction(() => {
        // Match Tandem's in-memory/JSON storage: sets win if a batch also removes a key.
        for (const key of writes.remove ?? [])
          connection.prepare(this.tables[key[1]].remove).run(encodeKey(key));
        for (const { key, value } of writes.set ?? []) {
          // SAFETY: TandemTuple pairs the collection key with the matching record type.
          const table = this.tables[key[1]] as {
            upsert: string;
            encode(record: typeof value): SqlValue[];
          };
          connection
            .prepare(table.upsert)
            .run(encodeKey(key), ...table.encode(value));
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
