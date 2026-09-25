import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { hc } from "hono/client";
import {
  TandemClient,
  type AnyRelations,
  type AnySchema,
  type RuntimeSchemaDefinition,
  type RemoteApi,
} from "@tanishqkancharla/tandem-core";
import * as errore from "errore";
import type { syncRouter } from "./sync.js";
import type { ExtensionWithApi, InferExtensionApi } from "./definition.js";

class ExtensionConnectionError extends errore.createTaggedError({
  name: "ExtensionConnectionError",
  message: "Extension connection failed",
}) {}

type SyncClient<Schema extends AnySchema> = {
  push(input: Parameters<RemoteApi<Schema>["push"]>[0]): Promise<void>;
  pull(
    input: Parameters<RemoteApi<Schema>["pull"]>[0],
  ): ReturnType<RemoteApi<Schema>["pull"]>;
  connect: RouterClient<ReturnType<typeof syncRouter>>["connect"];
};

export type ExtensionApiClient<Definition extends ExtensionWithApi> =
  ReturnType<typeof hc<InferExtensionApi<Definition>>>;

export type ConnectedExtension<
  Definition extends ExtensionWithApi,
  Schema extends AnySchema,
  Relations extends AnyRelations<Schema>,
> = {
  api: ExtensionApiClient<Definition>;
  storage: TandemClient<Schema, Relations>;
};

export function connectExtension<Definition extends ExtensionWithApi>(): <
  Schema extends AnySchema,
  Relations extends AnyRelations<Schema>,
>(args: {
  schema: RuntimeSchemaDefinition<Schema>;
  relations: Relations;
}) => Promise<ConnectedExtension<Definition, Schema, Relations> | Error> {
  return async function connect<
    Schema extends AnySchema,
    Relations extends AnyRelations<Schema>,
  >(args: { schema: RuntimeSchemaDefinition<Schema>; relations: Relations }) {
    const viewPath = "/view/";
    const extensionPath = location.pathname.slice(
      1,
      location.pathname.lastIndexOf(viewPath) + 1,
    );
    const apiPath = `/${extensionPath}api/` as const;
    const syncPath = `/${extensionPath}sync/` as const;
    const api = hc<InferExtensionApi<Definition>>(
      new URL(apiPath, location.origin).toString(),
    );
    const sync = createORPCClient<SyncClient<Schema>>(
      new RPCLink({ url: syncPath, origin: location.origin }),
    );
    const remote: RemoteApi<Schema> = {
      push: async (input) => await sync.push(input),
      pull: async (input) => await sync.pull(input),
      connect: async ({ clientId, poke }) => {
        const controller = new AbortController();
        const events = await sync.connect(
          { clientId },
          { signal: controller.signal },
        );
        // The first event confirms the server registered this client before push/pull can run.
        await events.next();
        const consumed = (async () => {
          for await (const event of events) {
            if (event.type === "poke") poke();
          }
        })().catch((cause) => {
          if (controller.signal.aborted) return;
          console.error(new ExtensionConnectionError({ cause }));
        });
        return async () => {
          controller.abort();
          await consumed;
        };
      },
    };
    const storage = new TandemClient({
      schema: args.schema,
      relations: args.relations,
      remote,
      autoConnect: false,
    });
    const ready = await storage.ready.catch(
      (cause) => new ExtensionConnectionError({ cause }),
    );
    if (ready instanceof Error) return ready;
    const connected = await storage
      .connect()
      .catch((cause) => new ExtensionConnectionError({ cause }));
    if (connected instanceof Error) return connected;
    return { api, storage };
  };
}
