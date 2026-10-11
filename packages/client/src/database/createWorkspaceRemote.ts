import {
  type ClientId,
  type ScanWindow,
  type Cookie,
  type RemoteApi,
} from "@tanishqkancharla/tandem-core";
import * as errore from "errore";
import type { HaloClient } from "../contract.js";
import type { WorkspaceSchema } from "./schema/workspaceSchema.js";

class WorkspaceSyncError extends errore.createTaggedError({
  name: "WorkspaceSyncError",
  message: "Workspace sync failed: $reason",
}) {}

export function createWorkspaceRemote(ctx: {
  api: HaloClient;
  signal: AbortSignal;
  onDisconnect: (error: Error) => void;
}) {
  return {
    push: async () => {
      throw new WorkspaceSyncError({
        reason: "use mutation RPCs; this replica is read-only",
      });
    },
    pull: async (input: {
      clientId: ClientId;
      cookie?: Cookie;
      scanWindow: ScanWindow<WorkspaceSchema>;
    }) => {
      const result = await ctx.api.sync
        .pull(input, { signal: ctx.signal })
        .catch((cause) => new WorkspaceSyncError({ reason: "pull", cause }));
      if (result instanceof Error) {
        if (!ctx.signal.aborted) ctx.onDisconnect(result);
        throw result;
      }
      return result;
    },
    connect: async ({
      clientId,
      poke,
    }: {
      clientId: ClientId;
      poke: () => void;
    }) => {
      const controller = new AbortController();
      const signal = AbortSignal.any([ctx.signal, controller.signal]);
      const events = await ctx.api.sync.connect({ clientId }, { signal });
      const first = await events.next();
      if (first.done || first.value.type !== "ready") {
        controller.abort();
        throw new WorkspaceSyncError({ reason: "missing ready event" });
      }
      const consumed = (async () => {
        for await (const event of events) {
          if (signal.aborted) return;
          if (event.type === "poke") poke();
        }
        if (!signal.aborted)
          ctx.onDisconnect(new WorkspaceSyncError({ reason: "stream ended" }));
      })().catch((cause) => {
        if (!signal.aborted)
          ctx.onDisconnect(new WorkspaceSyncError({ reason: "stream", cause }));
      });
      return async () => {
        controller.abort();
        await consumed;
      };
    },
  } satisfies RemoteApi<WorkspaceSchema>;
}
