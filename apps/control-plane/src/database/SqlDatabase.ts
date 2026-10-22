// oxlint-disable unicorn/no-null -- SQL parameters use NULL.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import * as errore from "errore";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import type { LoggerApi } from "@get-halo/logger";

export class SqlDatabaseError extends errore.createTaggedError({
  name: "SqlDatabaseError",
  message: "Database failed during $operation",
}) {}

/** Owns transaction ordering on one dedicated SQLite connection or a PostgreSQL pool. */
export class SqlDatabase {
  private readonly actionQueue = new SerialQueue();
  private readonly client: DatabaseSync | Pool;
  private readonly logger: LoggerApi;
  constructor(ctx: { client: DatabaseSync | Pool; logger: LoggerApi }) {
    this.client = ctx.client;
    this.logger = ctx.logger;
  }

  async transaction<T>(work: (sql: SqlTransaction) => Promise<T | Error>) {
    if (this.client instanceof DatabaseSync) {
      const client = this.client;
      return await this.actionQueue.run(async () => {
        const sql = new SqlTransaction({ client });
        const begun = await sql.query("BEGIN IMMEDIATE");
        if (begun instanceof Error) return begun;
        await using rollback = new errore.AsyncDisposableStack();
        rollback.defer(async () => {
          const rolledBack = await sql.query("ROLLBACK");
          if (rolledBack instanceof Error)
            this.logger.error({
              event: "database-rollback-failed",
              operation: "rollback",
              databaseType: "sqlite",
            });
        });
        const result = await work(sql);
        if (result instanceof Error) return result;
        const committed = await sql.query("COMMIT");
        if (committed instanceof Error) return committed;
        rollback.move();
        return result;
      });
    }
    const client = await this.client
      .connect()
      .catch((cause) => new SqlDatabaseError({ operation: "connect", cause })); // coverage-exempt: Rename-only change from AutomationDatabase.
    if (client instanceof Error) return client;
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => client.release());
    const sql = new SqlTransaction({ client }); // coverage-exempt: Rename-only change on the PostgreSQL transaction path.
    const begun = await sql.query("BEGIN");
    if (begun instanceof Error) return begun;
    await using rollback = new errore.AsyncDisposableStack();
    rollback.defer(async () => {
      const rolledBack = await sql.query("ROLLBACK");
      if (rolledBack instanceof Error)
        this.logger.error({
          event: "database-rollback-failed",
          operation: "rollback",
          databaseType: "postgres",
        });
    });
    const result = await work(sql);
    if (result instanceof Error) return result;
    const committed = await sql.query("COMMIT");
    if (committed instanceof Error) return committed;
    rollback.move();
    return result;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    query: string,
    parameters: (string | number | null)[] = [],
  ) {
    return await this.transaction(
      async (sql) => await sql.query<T>(query, parameters),
    );
  }
}

export class SqlTransaction {
  private readonly client: DatabaseSync | PoolClient;
  constructor(ctx: { client: DatabaseSync | PoolClient }) {
    this.client = ctx.client;
  }
  get lock() {
    return this.client instanceof DatabaseSync ? "" : " FOR UPDATE";
  }
  async query<T extends QueryResultRow = QueryResultRow>(
    query: string,
    parameters: (string | number | null)[] = [],
  ) {
    const client = this.client;
    if (client instanceof DatabaseSync)
      return errore.try({
        try: () => {
          const bindings: SQLInputValue[] = [];
          const text = query.replace(/\$(\d+)/g, (_match, index: string) => {
            bindings.push(parameters[Number(index) - 1]!);
            return "?";
          });
          // SAFETY: Callers name the row type matching their SQL projection.
          return client.prepare(text).all(...bindings) as T[];
        },
        catch: (cause) => new SqlDatabaseError({ operation: "query", cause }), // coverage-exempt: Rename-only change from AutomationDatabase.
      });
    const result = await client
      .query<T>(query, parameters)
      .catch((cause) => new SqlDatabaseError({ operation: "query", cause })); // coverage-exempt: Rename-only change from AutomationDatabase.
    if (result instanceof Error) return result;
    return result.rows;
  }
}
