import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  createDrizzleRuntimeSchemaFromTables,
  ensureDrizzleRuntimeSchemaFromTables,
} from "@executor-js/fumadb/adapters/drizzle";
import type { AbstractQuery } from "@executor-js/fumadb/query";
import type { AnySchema } from "@executor-js/fumadb/schema";
import { collectTables } from "@executor-js/sdk/core";
import { createExecutorFumaDb } from "@executor-js/sdk/host-internal";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import { drizzle as postgres } from "drizzle-orm/node-postgres";
import { drizzle as sqlite } from "drizzle-orm/sqlite-proxy";
import * as errore from "errore";
import type { DatabaseService } from "../DatabaseService.js";

class ExecutorDatabaseError extends errore.createTaggedError({
  name: "ExecutorDatabaseError",
  message: "Initialize Executor database",
}) {}

export async function createExecutorDatabase(db: DatabaseService) {
  const client = db.integrationClient;
  const options = {
    tables: collectTables(),
    namespace: "halo_executor",
    version: "1.0.0",
    provider:
      client instanceof DatabaseSync
        ? ("sqlite" as const)
        : ("postgresql" as const),
  };
  const schema = createDrizzleRuntimeSchemaFromTables(options);
  const database =
    client instanceof DatabaseSync
      ? sqlite(
          async (sql, params: SQLInputValue[], method) => {
            const statement = client.prepare(sql);
            statement.setReturnArrays(true);
            if (method === "run") {
              statement.run(...params);
              return { rows: [] };
            }
            // node:sqlite's typings still describe objects with setReturnArrays(true).
            const rows =
              method === "get"
                ? statement.get(...params)
                : statement.all(...params);
            return {
              rows:
                rows === undefined
                  ? []
                  : method === "get"
                    ? Object.values(rows)
                    : Object.values(rows).map(Object.values),
            };
          },
          { schema },
        )
      : postgres(client, { schema });
  const initialized = await ensureDrizzleRuntimeSchemaFromTables(
    database,
    options,
  ).catch((cause) => new ExecutorDatabaseError({ cause }));
  if (initialized instanceof Error) return initialized;
  const query = createExecutorFumaDb(database, options).db;
  return client instanceof DatabaseSync
    ? serialize(query, new SerialQueue())
    : query;
}

// Serialize whole transactions, not their individual statements. Preserve
// Fuma's non-enumerable policy context; transaction callbacks use the raw query.
function serialize<S extends AnySchema>(
  db: AbstractQuery<S>,
  queue: SerialQueue,
): AbstractQuery<S> {
  return {
    internal: db.internal,
    withContext: (context) => serialize(db.withContext!(context), queue),
    count: async (table, options) =>
      await queue.run(async () => await db.count(table, options)),
    findFirst: async (table, options) =>
      await queue.run(async () => await db.findFirst(table, options)),
    findMany: async (table, options) =>
      await queue.run(async () => await db.findMany(table, options)),
    create: async (table, values) =>
      await queue.run(async () => await db.create(table, values)),
    createMany: async (table, values) =>
      await queue.run(async () => await db.createMany(table, values)),
    updateMany: async (table, options) =>
      await queue.run(async () => await db.updateMany(table, options)),
    deleteMany: async (table, options) =>
      await queue.run(async () => await db.deleteMany(table, options)),
    upsert: async (table, options) =>
      await queue.run(async () => await db.upsert(table, options)),
    transaction: async (run) =>
      await queue.run(async () => await db.transaction(run)),
  };
}
