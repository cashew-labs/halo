import {
  createDrizzleRuntimeSchemaFromTables,
  createDrizzleRuntimeSchemaSqlFromTables,
} from "@executor-js/fumadb/adapters/drizzle";
import type { AbstractQuery } from "@executor-js/fumadb/query";
import type { AnySchema } from "@executor-js/fumadb/schema";
import type { FumaTables } from "@executor-js/sdk/core";
import {
  createExecutorFumaDb,
  type ExecutorFumaDb,
} from "@executor-js/sdk/host-internal";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type {
  DatabaseClient,
  DatabaseError,
} from "../../storage/DatabaseClient.js";

export async function createExecutorDatabase<T extends FumaTables>(
  client: DatabaseClient,
  tables: T,
): Promise<Pick<ExecutorFumaDb<T>, "db"> | DatabaseError> {
  return await client.access((connection) => {
    const options = {
      tables,
      namespace: "halo_executor",
      version: "1.0.0",
      provider: "sqlite" as const,
    };
    // Fuma's async schema initializer cannot use Turso's synchronous transaction callback.
    connection.transaction(() => {
      for (const sql of createDrizzleRuntimeSchemaSqlFromTables(options))
        connection.exec(sql);
    })();
    // Turso compat implements the synchronous statement API expected by this Drizzle driver.
    const database = drizzle(connection, {
      schema: createDrizzleRuntimeSchemaFromTables(options),
    });
    return {
      db: coordinateExecutor(
        client,
        createExecutorFumaDb(database, options).db,
      ),
    };
  });
}

function coordinateExecutor<S extends AnySchema>(
  client: DatabaseClient,
  db: AbstractQuery<S>,
): AbstractQuery<S> {
  const access = async <T>(run: () => Promise<T>) => {
    const result = await client.access(run);
    // Fuma's adapter contract reports storage failures as rejected promises.
    if (result instanceof Error) throw result;
    return result;
  };
  return {
    internal: db.internal,
    // Fuma supplies a non-enumerable withContext; decorators must preserve its policy context.
    withContext: (context) =>
      coordinateExecutor(client, db.withContext!(context)),
    count: async (table, options) =>
      await access(async () => await db.count(table, options)),
    findFirst: async (table, options) =>
      await access(async () => await db.findFirst(table, options)),
    findMany: async (table, options) =>
      await access(async () => await db.findMany(table, options)),
    create: async (table, values) =>
      await access(async () => await db.create(table, values)),
    createMany: async (table, values) =>
      await access(async () => await db.createMany(table, values)),
    updateMany: async (table, options) =>
      await access(async () => await db.updateMany(table, options)),
    deleteMany: async (table, options) =>
      await access(async () => await db.deleteMany(table, options)),
    upsert: async (table, options) =>
      await access(async () => await db.upsert(table, options)),
    // The callback receives Fuma's transaction query, so its operations do not acquire the queue again.
    transaction: async (run) =>
      await access(async () => await db.transaction(run)),
  };
}
