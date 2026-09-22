import { useRestartWarning } from "../confirmRestart.js";
import { useEffect, useState } from "react";
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
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly actionQueue = new SerialQueue();
  private readonly path: string;
  private readonly cache: (content: string) => void;
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
  }) {
    this.path = ctx.path;
    this.content = ctx.loaded;
    this.lastWritten = ctx.loaded;
    this.api = ctx.api;
    this.cache = ctx.cache;
    this.status = ctx.status;
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
        true,
      );
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
    this.status(error.message, true);
    return error;
  }
  private async save() {
    const content = this.content;
    if (content === this.lastWritten) return;
    if (!this.connected)
      return this.failed(
        new WorkspaceFileWriteError({
          detail: "Unsaved changes. Reconnect, then retry saving.",
        }),
      );
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
            detail:
              "Could not save this file. Your edits are still here; retry when connected.",
            cause,
          }),
      );
    if (written instanceof Error) {
      this.reconcile = true;
      return this.failed(written);
    }
    this.saved(content);
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
  const { state } = useConnection();
  const connected = state.status === "connected";
  const queryClient = useQueryClient();
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
        cache: (content) =>
          queryClient.setQueryData(["workspace-file", args.path], content),
      }),
  );
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
    onChange: (content: string) => save.onChange(content),
    message: progress.message,
    needsRetry: progress.needsRetry,
    retry: async () => {
      await save.flush();
    },
    connected,
  };
}
