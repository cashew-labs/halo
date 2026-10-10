import { implement } from "@orpc/server";
import { contract } from "@get-halo/client";
import { Stream } from "@get-halo/shared/Stream";
import * as errore from "errore";
import type { DatabaseService } from "./DatabaseService.js";

export type SyncRouterContext = { db: DatabaseService };
const os = implement(contract.sync).$context<SyncRouterContext>();

// The workspace HTTP router authenticates these requests before dispatch.
export const syncRouter = os.router({
  connect: os.connect.handler(async function* ({ context, input, signal }) {
    const changes = new Stream<{ type: "poke" }>();
    using updates = changes.consume({ abortSignal: signal });
    await using cleanup = new errore.AsyncDisposableStack();
    const disconnect = await context.db.connect({
      clientId: input.clientId,
      poke: () => changes.append({ type: "poke" }),
    });
    cleanup.defer(disconnect);
    if (signal?.aborted) return;
    yield { type: "ready" as const, clientId: input.clientId };
    yield* updates;
  }),
  pull: os.pull.handler(
    async ({ context, input }) => await context.db.pull(input),
  ),
});
