import { fileKind } from "./fileKind.js";
import { useFileSaveErrors } from "./FileSaveErrors.js";
import { useRestartWarning } from "../confirmRestart.js";
import { useEffect, useState, useId } from "react";
import * as errore from "errore";
import { useQueryClient } from "@tanstack/react-query";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import { useApi } from "../api/ApiProvider.js";
import { useConnection } from "../api/ConnectionContext.js";
import type { HaloClient } from "@get-halo/client";

const autosaveDelayMs = 400;
const fileSaves = new Set<FileAutosave>();

export async function flushFileAutosaves() {
  const results = await Promise.all(
    [...fileSaves].map(async (save) => await save.flush()),
  );
  return results.find((result) => result instanceof Error);
}

class WorkspaceFileWriteError extends errore.createTaggedError({
  name: "WorkspaceFileWriteError",
  message: "$detail",
}) {}

class FileAutosave {
  private mounted = false;
  private content: string;
  private lastWritten: string;
  private api: HaloClient;
  private connected = false;
  private reconcile = false;
  private pendingMerge = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly actionQueue = new SerialQueue();
  private readonly path: string;
  private readonly cache: (content: string) => void;
  private readonly synced: (content: string) => void;
  private readonly status: (
    message: string | undefined,
    needsRetry?: boolean,
  ) => void;

  constructor(ctx: {
    path: string;
    loaded: string;
    api: HaloClient;
    cache(content: string): void;
    status(message: string | undefined, needsRetry?: boolean): void;
    synced(content: string): void;
  }) {
    this.path = ctx.path;
    this.content = ctx.loaded;
    this.lastWritten = ctx.loaded;
    this.api = ctx.api;
    this.cache = ctx.cache;
    this.status = ctx.status;
    this.synced = ctx.synced;
  }
  mount() {
    this.mounted = true;
  }
  async unmount() {
    this.mounted = false;
    await this.flush();
    if (!this.mounted) fileSaves.delete(this);
  }
  updateConnection(api: HaloClient, connected: boolean) {
    if (api !== this.api || !connected) this.reconcile = true;
    this.api = api;
    this.connected = connected;
    if (this.content !== this.lastWritten)
      this.status(
        connected
          ? "Unsaved changes. Review and retry saving."
          : "Unsaved changes. Waiting for connection.",
        fileKind(this.path) !== "markdown",
      );
    if (
      connected &&
      fileKind(this.path) === "markdown" &&
      (this.content !== this.lastWritten || this.pendingMerge)
    ) {
      void this.flush().catch(console.error);
    }
  }
  beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.content === this.lastWritten) return;
    event.preventDefault();
  };
  onChange(content: string) {
    this.content = content;
    this.status(content === this.lastWritten ? undefined : "Unsaved changes");
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch(console.error);
    }, autosaveDelayMs);
  }
  async flush() {
    clearTimeout(this.timer);
    return await this.actionQueue.run(async () => await this.save());
  }
  private failed(error: WorkspaceFileWriteError) {
    console.warn(error);
    const message =
      error.cause instanceof Error
        ? `${error.message} ${error.cause.message}`
        : error.message;
    this.status(message, true);
    return error;
  }
  private async save() {
    const content = this.content;
    if (content === this.lastWritten && !this.pendingMerge) return;
    if (!this.connected)
      return this.failed(
        new WorkspaceFileWriteError({
          detail: "Unsaved changes. Reconnect, then retry saving.",
        }),
      );
    if (fileKind(this.path) === "markdown")
      return await this.saveMarkdown(content);
    const api = this.api;
    if (this.reconcile) {
      const remote = await api.workspace.readFile({ path: this.path }).catch(
        (cause) =>
          new WorkspaceFileWriteError({
            detail:
              "Could not check the file before saving. Your edits are still here.",
            cause,
          }),
      );
      if (remote instanceof Error) return this.failed(remote);
      if (remote !== this.lastWritten && remote !== content)
        return this.failed(
          new WorkspaceFileWriteError({
            detail:
              "This file changed on the server. Copy your edits before reopening it; Halo has not overwritten either version.",
          }),
        );
      if (remote === content) {
        this.saved(content);
        return;
      }
      this.reconcile = false;
    }
    const written = await api.workspace
      .writeFile({ path: this.path, content })
      .catch(
        (cause) =>
          new WorkspaceFileWriteError({
            detail: "Could not save this file. Your edits are still here.",
            cause,
          }),
      );
    if (written instanceof Error) {
      this.reconcile = true;
      return this.failed(written);
    }
    this.saved(content);
  }
  private async saveMarkdown(content: string) {
    const api = this.api;
    // The common case needs one request. Only a rejected conditional write
    // pays for reconciliation and a second write.
    let prepared = { content, expectedContent: this.lastWritten };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.connected || api !== this.api || content !== this.content)
        return;
      this.status("Saving note…");
      const written = await api.workspace
        .writeFile({ path: this.path, ...prepared })
        .catch(
          (cause) =>
            new WorkspaceFileWriteError({
              detail:
                "Could not save this note. Your edits are still here; retry when connected.",
              cause,
            }),
        );
      if (written instanceof Error) return this.failed(written);
      if (written.conflict) {
        if (attempt === 2) break;
        if (!this.connected || api !== this.api || content !== this.content)
          return;
        const merged = await api.workspace
          .reconcileNote({ path: this.path, base: this.lastWritten, content })
          .catch(
            (cause) =>
              new WorkspaceFileWriteError({
                detail:
                  "Could not merge this note. Your edits are still here; retry when connected.",
                cause,
              }),
          );
        if (merged instanceof Error) return this.failed(merged);
        prepared = merged;
        // The next iteration checks the draft and connection again before writing.
        continue;
      }
      // Edits typed during the final write still descend from the submitted draft,
      // not the merged result. The next save merges those edits against that base.
      this.lastWritten = content;
      this.pendingMerge = prepared.content !== content;
      if (content !== this.content) return;
      this.pendingMerge = false;
      this.content = prepared.content;
      this.lastWritten = prepared.content;
      this.cache(prepared.content);
      this.synced(prepared.content);
      this.status(undefined);
      return;
    }
    this.status("The note is still changing. Retrying save…");
    this.timer = setTimeout(() => {
      void this.flush().catch(console.error);
    }, 1000);
  }

  private saved(content: string) {
    this.lastWritten = content;
    if (content !== this.content) return;
    this.cache(content);
    this.status(undefined);
  }
}

export function useAutosaveFile(args: { path: string; loaded: string }) {
  const api = useApi();
  const { service: errors } = useFileSaveErrors();
  const errorId = useId();
  const { state } = useConnection();
  const connected = state.status === "connected";
  const queryClient = useQueryClient();
  const [loaded, setLoaded] = useState(args.loaded);
  const [progress, setProgress] = useState<{
    message: string | undefined;
    needsRetry: boolean;
  }>({ message: undefined, needsRetry: false });
  useRestartWarning(progress.message !== undefined);
  const [save] = useState(
    () =>
      new FileAutosave({
        ...args,
        api,
        status: (message, needsRetry = false) =>
          setProgress({ message, needsRetry }),
        synced: setLoaded,
        cache: (content) =>
          queryClient.setQueryData(["workspace-file", args.path], content),
      }),
  );
  useEffect(() => {
    if (progress.needsRetry && progress.message !== undefined)
      errors.report({
        id: errorId,
        path: args.path,
        message: progress.message,
        retry: async () => {
          await save.flush();
        },
      });
    else if (progress.message === undefined) errors.clear(errorId);
  }, [errors, errorId, args.path, progress, save]);
  useEffect(() => () => errors.clear(errorId), [errors, errorId]);
  useEffect(() => {
    save.updateConnection(api, connected);
  }, [save, api, connected]);
  useEffect(() => {
    save.mount();
    fileSaves.add(save);
    window.addEventListener("beforeunload", save.beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", save.beforeUnload);
      void save.unmount().catch(console.error);
    };
  }, [save]);
  return {
    loaded,
    onChange: (content: string) => save.onChange(content),
    message: progress.message,
    needsRetry: progress.needsRetry,
    retry: async () => {
      await save.flush();
    },
    connected,
  };
}
