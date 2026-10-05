import * as errore from "errore";
import type { HaloClient } from "@get-halo/client";

type DroppedEntry =
  | { kind: "file"; path: string; file: File }
  | { kind: "directory"; path: string };

class FileDropError extends errore.createTaggedError({
  name: "FileDropError",
  message: "Could not read '$path' from your computer.",
}) {}

class FileUploadError extends errore.createTaggedError({
  name: "FileUploadError",
  message: "Could not upload '$path': $reason",
}) {}

export function hasDroppedFiles(transfer: DataTransfer) {
  return transfer.types.includes("Files");
}

export async function readDroppedFiles(transfer: DataTransfer) {
  // The browser exposes the drag store only during the drop event. Capture
  // every entry/file before awaiting directory traversal or file reads.
  const roots = Array.from(transfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => ({
      entry: item.webkitGetAsEntry(),
      file: item.getAsFile(),
    }));
  const entries: DroppedEntry[] = [];
  const skipped: string[] = [];
  for (const root of roots) {
    if (root.entry !== null) {
      const read = await readEntry({
        entry: root.entry,
        parent: "",
        entries,
        skipped,
      });
      if (read instanceof Error) return read;
      continue;
    }
    if (root.file !== null) {
      entries.push({ kind: "file", path: root.file.name, file: root.file });
    }
  }
  return { entries, skipped };
}

async function readEntry({
  entry,
  parent,
  entries,
  skipped,
}: {
  entry: FileSystemEntry;
  parent: string;
  entries: DroppedEntry[];
  skipped: string[];
}): Promise<void | FileDropError> {
  const path = parent === "" ? entry.name : `${parent}/${entry.name}`;
  // Match the server's visible workspace policy without failing a whole
  // folder import on Finder metadata or a dependency directory.
  if (
    parent !== "" &&
    (entry.name.startsWith(".") || entry.name === "node_modules")
  ) {
    skipped.push(path);
    return;
  }
  if (entry.isFile) {
    // SAFETY: The browser's isFile discriminator identifies a FileSystemFileEntry.
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File | FileDropError>((resolve) => {
      fileEntry.file(resolve, (cause) =>
        resolve(new FileDropError({ path, cause })),
      );
    });
    if (file instanceof Error) return file;
    entries.push({ kind: "file", path, file });
    return;
  }
  if (!entry.isDirectory) return new FileDropError({ path });
  entries.push({ kind: "directory", path });
  // SAFETY: The browser's isDirectory discriminator identifies a directory entry.
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // Chromium returns directory entries in batches, including an empty last batch.
  while (true) {
    const children = await new Promise<FileSystemEntry[] | FileDropError>(
      (resolve) => {
        reader.readEntries(resolve, (cause) =>
          resolve(new FileDropError({ path, cause })),
        );
      },
    );
    if (children instanceof Error) return children;
    if (children.length === 0) return;
    for (const child of children) {
      const read = await readEntry({
        entry: child,
        parent: path,
        entries,
        skipped,
      });
      if (read instanceof Error) return read;
    }
  }
}

export async function uploadDroppedFiles({
  api,
  folder,
  entries,
  onProgress,
  skipped,
}: {
  api: HaloClient;
  folder: string;
  entries: DroppedEntry[];
  onProgress: (message: string) => void;
  skipped: string[];
}) {
  for (const [index, entry] of entries.entries()) {
    onProgress(`Uploading ${index + 1} of ${entries.length} items…`);
    const path = folder === "" ? entry.path : `${folder}/${entry.path}`;
    const uploaded = await (
      entry.kind === "directory"
        ? api.workspace.createEntry({ path, kind: "directory" })
        : api.workspace.uploadFile({ path, file: entry.file })
    ).catch(
      (cause) =>
        new FileUploadError({
          path,
          reason: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    );
    if (uploaded instanceof Error) return uploaded;
  }
  onProgress(
    `Uploaded ${entries.length} ${entries.length === 1 ? "item" : "items"}.` +
      (skipped.length === 0
        ? ""
        : ` Skipped ${skipped.length} hidden or dependency ${skipped.length === 1 ? "item" : "items"}.`),
  );
}
