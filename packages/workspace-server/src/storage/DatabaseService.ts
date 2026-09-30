import {
  collection,
  defineRelations,
  defineSchema,
  type SchemaFromCollections,
} from "@tanishqkancharla/tandem-core";
import { TandemServer } from "@tanishqkancharla/tandem-server";
import * as errore from "errore";
import type { Hotkey, Routine, RoutineRun } from "@get-halo/client";
import { DatabaseClient } from "./DatabaseClient.js";
import { TursoTupleStorage } from "./TursoTupleStorage.js";

class DatabaseServiceError extends errore.createTaggedError({
  name: "DatabaseServiceError",
  message: "Database service failed during $operation",
}) {}

const schema = defineSchema({
  hotkeys: collection<Hotkey & { userId: string; position: number }>(),
  routines: collection<
    Omit<Routine, "lastRun"> & { lastRunId?: string; runSequence: number }
  >({
    fields: [
      "id",
      "extensionId",
      "name",
      "cron",
      "timezone",
      "action",
      "enabled",
      "autoArchiveSession",
      "nextRunAt",
      "createdAt",
      "updatedAt",
      "lastRunId",
      "runSequence",
    ],
  }),
  routineRuns: collection<RoutineRun & { sequence: number }>({
    fields: [
      "id",
      "routineId",
      "trigger",
      "scheduledFor",
      "sessionId",
      "status",
      "startedAt",
      "finishedAt",
      "error",
      "sequence",
    ],
  }),
});
const relations = defineRelations(schema, ({ one, many }) => ({
  routines: {
    lastRun: one("routineRuns", { from: "lastRunId", to: "id" }),
    runs: many("routineRuns", { from: "id", to: "routineId" }),
  },
  routineRuns: { routine: one("routines", { from: "routineId", to: "id" }) },
}));
export type WorkspaceSchema = SchemaFromCollections<typeof schema.collections>;

export type NativeConnection = Pick<DatabaseClient, "access">;

export class DatabaseService {
  // Owns both lifetimes; native handles share the client's connection and queue.
  readonly tandem: TandemServer<WorkspaceSchema, typeof relations>;
  private readonly client: DatabaseClient;

  private constructor(ctx: { client: DatabaseClient }) {
    const { client } = ctx;
    this.client = client;
    this.tandem = new TandemServer({
      schema,
      relations,
      storage: new TursoTupleStorage({
        database: this.createNativeConnection(),
      }),
    });
  }

  static async open(input: Parameters<typeof DatabaseClient.open>[0]) {
    const client = await DatabaseClient.open(input);
    if (client instanceof Error) return client;
    return new DatabaseService({ client });
  }

  createNativeConnection(): NativeConnection {
    return { access: async (operation) => await this.client.access(operation) };
  }

  async close() {
    const tandemClosed = await this.tandem
      .close()
      .catch(
        (cause) =>
          new DatabaseServiceError({ operation: "close Tandem", cause }),
      );
    const clientClosed = await this.client.close();
    if (tandemClosed instanceof Error) return tandemClosed;
    if (clientClosed instanceof Error) return clientClosed;
  }
}
