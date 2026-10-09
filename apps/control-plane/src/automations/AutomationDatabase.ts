// oxlint-disable unicorn/no-null -- SQL parameters use NULL.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import * as errore from "errore";
import { SerialQueue } from "@get-halo/shared/SerialQueue";

export class AutomationDatabaseError extends errore.createTaggedError({
  name: "AutomationDatabaseError",
  message: "Automation database failed during $operation",
}) {}

/** Owns transaction ordering on the dedicated local automation connection. */
export class AutomationDatabase {
  private readonly actionQueue = new SerialQueue();
  private readonly client: DatabaseSync | Pool;
  constructor(ctx: { client: DatabaseSync | Pool }) {
    this.client = ctx.client;
  }

  async transaction<T>(work: (sql: AutomationSql) => Promise<T | Error>) {
    if (this.client instanceof DatabaseSync) {
      const client = this.client;
      return await this.actionQueue.run(async () => {
        const sql = new AutomationSql({ client });
        const begun = await sql.query("BEGIN IMMEDIATE");
        if (begun instanceof Error) return begun;
        await using rollback = new errore.AsyncDisposableStack();
        rollback.defer(async () => {
          const rolledBack = await sql.query("ROLLBACK");
          if (rolledBack instanceof Error) console.error(rolledBack);
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
      .catch(
        (cause) => new AutomationDatabaseError({ operation: "connect", cause }),
      );
    if (client instanceof Error) return client;
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => client.release());
    const sql = new AutomationSql({ client });
    const begun = await sql.query("BEGIN");
    if (begun instanceof Error) return begun;
    await using rollback = new errore.AsyncDisposableStack();
    rollback.defer(async () => {
      const rolledBack = await sql.query("ROLLBACK");
      if (rolledBack instanceof Error) console.error(rolledBack);
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

export class AutomationSql {
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
        catch: (cause) =>
          new AutomationDatabaseError({ operation: "query", cause }),
      });
    const result = await client
      .query<T>(query, parameters)
      .catch(
        (cause) => new AutomationDatabaseError({ operation: "query", cause }),
      );
    if (result instanceof Error) return result;
    return result.rows;
  }
}
