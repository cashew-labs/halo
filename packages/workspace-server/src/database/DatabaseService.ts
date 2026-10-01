import { TandemServer } from "@tanishqkancharla/tandem-server";
import * as errore from "errore";
import { DatabaseClient } from "./DatabaseClient.js";
import { TursoTupleStorage } from "./TursoTupleStorage.js";
import {
  haloSchemaToTandemSchema,
  workspaceSchema,
  type WorkspaceSchema,
} from "@get-halo/client";
export type { WorkspaceSchema } from "@get-halo/client";

class DatabaseServiceError extends errore.createTaggedError({
  name: "DatabaseServiceError",
  message: "Database service failed during $operation",
}) {}

export type NativeConnection = Pick<DatabaseClient, "access">;

export class DatabaseService {
  // Weak references let disposal track active transactions without retaining them.
  private readonly activeTransactions = new WeakSet<object>();
  // Owns both lifetimes; native handles share the client's connection and queue.
  private readonly tandem: TandemServer<
    WorkspaceSchema,
    ReturnType<
      typeof haloSchemaToTandemSchema<typeof workspaceSchema>
    >["relations"]
  >;
  private readonly client: DatabaseClient;
  readonly query: DatabaseService["tandem"]["query"];
  readonly subscribe: DatabaseService["tandem"]["subscribe"];
  readonly connect: DatabaseService["tandem"]["connect"];
  readonly pull: DatabaseService["tandem"]["pull"];

  private constructor(ctx: { client: DatabaseClient }) {
    const { client } = ctx;
    this.client = client;
    const { schema, relations } = haloSchemaToTandemSchema(workspaceSchema);
    this.tandem = new TandemServer({
      schema,
      relations,
      storage: new TursoTupleStorage({
        schema: workspaceSchema,
        database: this.createNativeConnection(),
      }),
    });
    this.query = this.tandem.query.bind(this.tandem);
    this.subscribe = this.tandem.subscribe.bind(this.tandem);
    this.connect = this.tandem.connect.bind(this.tandem);
    this.pull = this.tandem.pull.bind(this.tandem);
  }

  static async open(input: Parameters<typeof DatabaseClient.open>[0]) {
    const client = await DatabaseClient.open(input);
    if (client instanceof Error) return client;
    return new DatabaseService({ client });
  }

  createNativeConnection(): NativeConnection {
    return { access: async (operation) => await this.client.access(operation) };
  }

  transact() {
    return this.tandem.transact();
  }

  useTransaction() {
    const tx = this.transact();
    const cancel = tx.cancel.bind(tx);
    this.activeTransactions.add(tx);
    return Object.assign(tx, {
      cancel: async () => {
        this.activeTransactions.delete(tx);
        return await cancel();
      },
      [Symbol.asyncDispose]: async () => {
        if (!this.activeTransactions.delete(tx)) return;
        await cancel().catch((cause) =>
          console.warn(
            new DatabaseServiceError({
              operation: "cancel transaction",
              cause,
            }),
          ),
        );
      },
    });
  }

  async commit(tx: ReturnType<DatabaseService["transact"]>) {
    // A commit attempt consumes the transaction, even when it rejects.
    this.activeTransactions.delete(tx);
    return await this.tandem.commit(tx);
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
