import { useEffect, useState } from "react";
import * as errore from "errore";
import { useQueryClient } from "@tanstack/react-query";
import { useApi } from "../api/ApiProvider.tsx";
import type { HaloClient } from "@get-halo/shared/contract";

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
  message:
    "Failed to save $path. Please try again before changing its location or deleting it.",
}) {}

class FileAutosave {
  private mounted = false;

  mount() {
    this.mounted = true;
  }

  async unmount() {
    this.mounted = false;
    await this.flush();
    if (!this.mounted) fileSaves.delete(this);
  }
  private content: string;
  private lastWritten: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private write: Promise<void | WorkspaceFileWriteError> = Promise.resolve();

  constructor(
    private readonly options: {
      path: string;
      loaded: string;
      api: HaloClient;
      cache(content: string): void;
    },
  ) {
    this.content = options.loaded;
    this.lastWritten = options.loaded;
  }

  onChange(content: string) {
    this.content = content;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch(console.error);
    }, autosaveDelayMs);
  }

  async flush() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.write = this.write.then(async () => await this.save());
    return await this.write;
  }

  private async save() {
    const content = this.content;
    if (content === this.lastWritten) return;
    const { path, api } = this.options;
    const written = await api.workspace
      .writeFile({ path, content })
      .catch((cause) => new WorkspaceFileWriteError({ path, cause }));
    if (written instanceof Error) {
      console.warn(written);
      return written;
    }
    this.lastWritten = content;
    if (content === this.content) this.options.cache(content);
  }
}

export function useAutosaveFile(args: { path: string; loaded: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [save] = useState(
    () =>
      new FileAutosave({
        ...args,
        api,
        cache: (content) =>
          queryClient.setQueryData(["workspace-file", args.path], content),
      }),
  );

  useEffect(() => {
    save.mount();
    fileSaves.add(save);
    return () => {
      void save.unmount().catch(console.error);
    };
  }, [save]);

  return { onChange: (content: string) => save.onChange(content) };
}
