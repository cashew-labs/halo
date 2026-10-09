import fs from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as errore from "errore";
import { Pool } from "pg";

class DatabaseServiceError extends errore.createTaggedError({
  name: "DatabaseServiceError",
  message: "Database failed: $detail",
}) {}

export type DatabaseConfig =
  | { type: "sqlite"; path: string }
  | { type: "postgres"; connectionString: string };

export type DatabaseClient = DatabaseSync | Pool;

export class DatabaseService {
  private readonly database: DatabaseClient;
  private readonly integrations: DatabaseClient;
  readonly automationClient: DatabaseClient;

  private constructor(ctx: {
    client: DatabaseClient;
    integrations: DatabaseClient;
    automations: DatabaseClient;
  }) {
    this.database = ctx.client;
    this.integrations = ctx.integrations;
    this.automationClient = ctx.automations;
  }

  static async start(config: DatabaseConfig) {
    if (config.type === "postgres") {
      const client = errore.try({
        try: () =>
          new Pool({ connectionString: config.connectionString, max: 5 }),
        catch: (cause) =>
          new DatabaseServiceError({ detail: "open PostgreSQL pool", cause }),
      });
      if (client instanceof Error) return client;

      return new DatabaseService({
        client,
        integrations: client,
        automations: client,
      });
    }

    const created = await fs
      .mkdir(dirname(config.path), { recursive: true, mode: 0o700 })
      .catch(
        (cause) =>
          new DatabaseServiceError({
            detail: "create data directory",
            cause,
          }),
      );
    if (created instanceof Error) return created;

    const client = errore.try({
      try: () => new DatabaseSync(config.path),
      catch: (cause) =>
        new DatabaseServiceError({ detail: "open SQLite database", cause }),
    });
    if (client instanceof Error) return client;

    // SQLite has one writer. Keep asynchronous Executor transactions off the
    // synchronous auth connection (and its file), while owning both lifetimes.
    const integrations = errore.try({
      try: () => new DatabaseSync(`${config.path}.integrations`),
      catch: (cause) =>
        new DatabaseServiceError({
          detail: "open integration database",
          cause,
        }),
    });
    if (integrations instanceof Error) {
      client.close();
      return integrations;
    }
    const automations = errore.try({
      try: () => new DatabaseSync(`${config.path}.automations`),
      catch: (cause) =>
        new DatabaseServiceError({ detail: "open automation database", cause }),
    });
    if (automations instanceof Error) {
      integrations.close();
      client.close();
      return automations;
    }
    return new DatabaseService({ client, integrations, automations });
  }

  get client() {
    return this.database;
  }

  get integrationClient() {
    return this.integrations;
  }

  async close() {
    const client = this.database;

    if (client instanceof DatabaseSync) {
      return errore.try({
        try: () => {
          if (this.integrations instanceof DatabaseSync)
            this.integrations.close();
          if (this.automationClient instanceof DatabaseSync)
            this.automationClient.close();
          client.close();
        },
        catch: (cause) =>
          new DatabaseServiceError({
            detail: "close SQLite database",
            cause,
          }),
      });
    }

    return await client.end().catch(
      (cause) =>
        new DatabaseServiceError({
          detail: "close PostgreSQL pool",
          cause,
        }),
    );
  }
}
