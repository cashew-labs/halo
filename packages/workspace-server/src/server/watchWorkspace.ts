import * as errore from "errore";
import { type WorkspaceUpdate } from "@get-halo/client";
import { Stream } from "@get-halo/shared/Stream";
import { orpcErrors } from "../orpcErrors.js";
import type { HaloContext } from "./router.js";

class WorkspaceWatchError extends errore.createTaggedError({
  name: "WorkspaceWatchError",
  message: "Workspace updates disconnected",
}) {}

// One HTTP stream carries the app-wide subscriptions, leaving browser
// connections available for transcripts, prompts, cancellation, and file I/O.
export async function* watchWorkspace({
  context,
  includeAutomations,
  includeLegacyState,
  signal,
}: {
  context: HaloContext;
  includeAutomations?: boolean;
  includeLegacyState?: boolean;
  signal: AbortSignal | undefined;
}) {
  const closed = new AbortController();
  const abortSignal =
    signal === undefined
      ? closed.signal
      : AbortSignal.any([signal, closed.signal]);
  const events = new Stream<WorkspaceUpdate | Error>();
  using updates = events.consume({ abortSignal });
  using files =
    includeLegacyState === false
      ? undefined
      : context.workspace.treeEvents.consume({ abortSignal });
  const tasks = [
    forward(context.extensions.watch(abortSignal), (extensions) =>
      extensions instanceof Error
        ? { type: "extensionsError", message: extensions.message }
        : { type: "extensions", extensions },
    ),
    forward(context.sessions.watchSummaries(abortSignal), (update) => ({
      type: "sessions",
      update,
    })),
  ];
  // Protocol 25/26 clients have neither Tandem reads nor scoped folder listings.
  if (files !== undefined) {
    tasks.push(
      forward(context.hotkeys.watch(abortSignal), (hotkeys) => ({
        type: "hotkeys",
        hotkeys,
      })),
      forward(files, (batch) => ({ type: "files", events: batch })),
    );
  }
  // Automation consumers explicitly opt into these snapshots.
  if (includeAutomations === true) {
    tasks.push(
      forward(context.automations.watch(abortSignal), (automations) => ({
        type: "automations",
        automations,
      })),
    );
  }
  await using cleanup = new errore.AsyncDisposableStack();
  cleanup.defer(async () => {
    closed.abort();
    await Promise.all(tasks);
  });
  for await (const update of updates) {
    if (update instanceof Error) throw orpcErrors.badRequest(update);
    yield update;
  }

  // Each source owns its snapshot/subscription ordering and buffers changes
  // while the other sources initialize. Rejections terminate this RPC stream.
  async function forward<T>(
    source: AsyncIterable<T>,
    map: (value: T) => WorkspaceUpdate | Error,
  ) {
    await (async () => {
      for await (const item of source) events.append(map(item));
    })().catch((cause) => events.append(new WorkspaceWatchError({ cause })));
  }
}
