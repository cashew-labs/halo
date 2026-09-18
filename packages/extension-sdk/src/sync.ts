import { EventEmitter, on } from "node:events";
import { os, type } from "@orpc/server";
import type {
  ClientId,
  RemoteApi,
  AnySchema,
} from "@tanishqkancharla/tandem-core";
import * as errore from "errore";

class ExtensionSyncError extends errore.createTaggedError({
  name: "ExtensionSyncError",
  message: "Extension sync failed",
}) {}

export function syncRouter<Schema extends AnySchema>(
  remote: RemoteApi<Schema>,
) {
  return {
    push: os
      .input(type<Parameters<typeof remote.push>[0]>())
      .handler(async ({ input }) => {
        const result = await remote
          .push(input)
          .catch((cause) => new ExtensionSyncError({ cause }));
        if (result instanceof Error) throw result;
      }),
    pull: os
      .input(type<Parameters<typeof remote.pull>[0]>())
      .handler(async ({ input }) => {
        const result = await remote
          .pull(input)
          .catch((cause) => new ExtensionSyncError({ cause }));
        if (result instanceof Error) throw result;
        return result;
      }),
    connect: os.input(type<{ clientId: ClientId }>()).handler(async function* ({
      input,
      signal,
    }) {
      const emitter = new EventEmitter();
      const events = on(emitter, "poke", { signal });
      await using cleanup = new errore.AsyncDisposableStack();
      cleanup.defer(async () => {
        await events.return?.();
      });
      const disconnect = await remote
        .connect({
          ...input,
          poke: () => {
            emitter.emit("poke");
          },
        })
        .catch((cause) => new ExtensionSyncError({ cause }));
      if (disconnect instanceof Error) throw disconnect;
      cleanup.defer(disconnect);
      yield { type: "ready" as const };
      while (true) {
        const next = await events
          .next()
          .catch((cause) => new ExtensionSyncError({ cause }));
        if (next instanceof Error) {
          if (signal?.aborted) return;
          throw next;
        }
        if (next.done) return;
        yield { type: "poke" as const };
      }
    }),
  };
}
