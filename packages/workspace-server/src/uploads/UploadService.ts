import crypto from "node:crypto";
import path from "node:path";
import * as errore from "errore";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import { chatAttachmentLimits, validateChatFiles } from "@get-halo/client";
import type { FilesystemService } from "../filesystem/FilesystemService.js";

export class UploadRejectedError extends errore.createTaggedError({
  name: "UploadRejectedError",
  message: "$reason",
}) {}
export class UploadNotFoundError extends errore.createTaggedError({
  name: "UploadNotFoundError",
  message: "This upload no longer exists. Attach the file again.",
}) {}
export class UploadIncompleteError extends errore.createTaggedError({
  name: "UploadIncompleteError",
  message: "$fileName is still uploading.",
}) {}
export class UploadOffsetError extends errore.createTaggedError({
  name: "UploadOffsetError",
  message: "The upload expected data at byte $expected, not $offset.",
}) {}
export class UploadStorageError extends errore.createTaggedError({
  name: "UploadStorageError",
  message: "Could not store $fileName in the workspace.",
}) {}
export class UploadCleanupError extends errore.createTaggedError({
  name: "UploadCleanupError",
  message: "Could not remove the upload of $fileName.",
}) {}

/** A completed upload that has moved to its permanent attachment path. */
export type ClaimedUpload = {
  uploadId: string;
  name: string;
  size: number;
  mimeType: string;
  /** Workspace-relative POSIX path shown to people and the model. */
  path: string;
  absolutePath: string;
};

type Upload = {
  name: string;
  size: number;
  mimeType: string;
  received: number;
  expiry: ReturnType<typeof setTimeout>;
};

// Uploads that are never sent are deleted a day after their last chunk.
const uploadLifetimeMs = 24 * 60 * 60_000;
// Leave room for threads, the database, and tool output after a large upload.
const reservedDiskBytes = 256_000_000;

/**
 * Receives chat attachments in chunks before their message is sent. Staged
 * files live under `.halo/uploads/` and move to `attachments/<uploadId>/` when
 * a prompt claims them.
 */
export class UploadService {
  // Uploads that are receiving chunks or waiting for a message, by upload ID.
  private readonly uploads = new Map<string, Upload>();
  // Orders chunk writes, cancellation, and claims across uploads.
  private readonly actionQueue = new SerialQueue();
  private readonly filesystem: FilesystemService;
  private readonly workspaceRoot: string;
  private readonly stagingDirectory: string;

  constructor(ctx: { filesystem: FilesystemService; workspaceRoot: string }) {
    const { filesystem, workspaceRoot } = ctx;
    this.filesystem = filesystem;
    this.workspaceRoot = workspaceRoot;
    this.stagingDirectory = path.join(workspaceRoot, ".halo", "uploads");
  }

  /** Removes staged files left by a previous server process. */
  async start() {
    const removed = await this.filesystem.remove(this.stagingDirectory, {
      recursive: true,
      force: true,
    });
    if (removed instanceof Error) return removed;
    return await this.filesystem.makeDirectory(this.stagingDirectory, {
      recursive: true,
    });
  }

  close() {
    for (const upload of this.uploads.values()) clearTimeout(upload.expiry);
    this.uploads.clear();
  }

  async create(input: { name: string; size: number; mimeType: string }) {
    if (!Number.isSafeInteger(input.size) || input.size < 0)
      return new UploadRejectedError({ reason: "The file size is invalid." });
    const invalid = validateChatFiles([input]);
    if (invalid !== undefined)
      return new UploadRejectedError({ reason: invalid });
    return await this.actionQueue.run(async () => {
      const available = await this.filesystem.availableBytes(
        this.stagingDirectory,
      );
      if (available instanceof Error)
        return new UploadStorageError({
          fileName: input.name,
          cause: available,
        });
      const reserved = [...this.uploads.values()].reduce(
        (total, upload) => total + upload.size - upload.received,
        reservedDiskBytes,
      );
      if (input.size + reserved > available)
        return new UploadRejectedError({
          reason: `The workspace does not have enough free disk space for ${input.name}.`,
        });
      const uploadId = crypto.randomUUID();
      const directory = path.join(this.stagingDirectory, uploadId);
      const created = await this.filesystem.makeDirectory(directory);
      if (created instanceof Error)
        return new UploadStorageError({ fileName: input.name, cause: created });
      const written = await this.filesystem.writeFile(
        path.join(directory, input.name),
        new Uint8Array(),
        { flag: "wx" },
      );
      if (written instanceof Error)
        return new UploadStorageError({ fileName: input.name, cause: written });
      this.uploads.set(uploadId, {
        name: input.name,
        size: input.size,
        mimeType: input.mimeType,
        received: 0,
        expiry: this.expire(uploadId),
      });
      return { uploadId };
    });
  }

  async write(input: { uploadId: string; offset: number; chunk: Blob }) {
    if (
      input.chunk.size === 0 ||
      input.chunk.size > chatAttachmentLimits.uploadChunkBytes
    )
      return new UploadRejectedError({
        reason: "Upload chunks must contain 1 byte to 8 MiB.",
      });
    // oRPC has already read the request body into this in-memory chunk.
    const bytes = await input.chunk.arrayBuffer();
    return await this.actionQueue.run(async () => {
      const upload = this.uploads.get(input.uploadId);
      if (upload === undefined) return new UploadNotFoundError();
      // A retry after a lost response repeats a chunk the server already stored.
      if (
        input.offset >= 0 &&
        input.offset + bytes.byteLength <= upload.received
      )
        return { received: upload.received };
      if (input.offset !== upload.received)
        return new UploadOffsetError({
          expected: upload.received,
          offset: input.offset,
        });
      if (upload.received + bytes.byteLength > upload.size)
        return new UploadRejectedError({
          reason: `${upload.name} is larger than the size given when its upload started.`,
        });
      // Positional writes let a retry overwrite a partially written chunk.
      const written = await this.filesystem.writeAt(
        this.stagedPath(input.uploadId, upload),
        new Uint8Array(bytes),
        upload.received,
      );
      if (written instanceof Error)
        return new UploadStorageError({
          fileName: upload.name,
          cause: written,
        });
      upload.received += bytes.byteLength;
      clearTimeout(upload.expiry);
      upload.expiry = this.expire(input.uploadId);
      return { received: upload.received };
    });
  }

  status(input: { uploadId: string }) {
    const upload = this.uploads.get(input.uploadId);
    if (upload === undefined) return new UploadNotFoundError();
    return { received: upload.received, size: upload.size };
  }

  async cancel(input: { uploadId: string }) {
    return await this.actionQueue.run(
      async () => await this.cancelUnqueued(input.uploadId),
    );
  }

  /**
   * Moves completed uploads to `attachments/<uploadId>/<name>`. Call
   * {@link release} if the message that claimed them is not accepted.
   */
  async claim(uploadIds: readonly string[]) {
    return await this.actionQueue.run(async () => {
      const uniqueIds = [...new Set(uploadIds)];
      if (uniqueIds.length > chatAttachmentLimits.files)
        return new UploadRejectedError({
          reason: "Attach up to 10 files per message.",
        });
      const pending: { uploadId: string; upload: Upload }[] = [];
      for (const uploadId of uniqueIds) {
        const upload = this.uploads.get(uploadId);
        if (upload === undefined) return new UploadNotFoundError();
        if (upload.received < upload.size)
          return new UploadIncompleteError({ fileName: upload.name });
        pending.push({ uploadId, upload });
      }
      const claimed: ClaimedUpload[] = [];
      for (const { uploadId, upload } of pending) {
        const moved = await this.claimUnqueued(uploadId, upload);
        if (moved instanceof Error) {
          const released = await this.releaseUnqueued(claimed);
          if (released instanceof Error)
            console.warn("Could not restore claimed uploads:", released);
          return moved;
        }
        claimed.push(moved);
      }
      return claimed;
    });
  }

  /** Returns claimed uploads to staging so a later message can send them. */
  async release(claimed: readonly ClaimedUpload[]) {
    return await this.actionQueue.run(
      async () => await this.releaseUnqueued(claimed),
    );
  }

  private async claimUnqueued(uploadId: string, upload: Upload) {
    const directory = path.join(this.workspaceRoot, "attachments", uploadId);
    const created = await this.filesystem.makeDirectory(directory, {
      recursive: true,
    });
    if (created instanceof Error)
      return new UploadStorageError({ fileName: upload.name, cause: created });
    const absolutePath = path.join(directory, upload.name);
    const moved = await this.filesystem.rename(
      this.stagedPath(uploadId, upload),
      absolutePath,
    );
    if (moved instanceof Error)
      return new UploadStorageError({ fileName: upload.name, cause: moved });
    clearTimeout(upload.expiry);
    this.uploads.delete(uploadId);
    const removed = await this.filesystem.remove(
      path.join(this.stagingDirectory, uploadId),
      { recursive: true, force: true },
    );
    if (removed instanceof Error)
      console.warn("Could not remove claimed upload staging:", removed);
    return {
      uploadId,
      name: upload.name,
      size: upload.size,
      mimeType: upload.mimeType,
      path: path
        .relative(this.workspaceRoot, absolutePath)
        .split(path.sep)
        .join("/"),
      absolutePath,
    };
  }

  private async releaseUnqueued(claimed: readonly ClaimedUpload[]) {
    for (const file of claimed) {
      const directory = path.join(this.stagingDirectory, file.uploadId);
      const created = await this.filesystem.makeDirectory(directory, {
        recursive: true,
      });
      if (created instanceof Error)
        return new UploadStorageError({ fileName: file.name, cause: created });
      const moved = await this.filesystem.rename(
        file.absolutePath,
        path.join(directory, file.name),
      );
      if (moved instanceof Error)
        return new UploadStorageError({ fileName: file.name, cause: moved });
      // Conversion may leave rendered pages beside the attachment.
      const removed = await this.filesystem.remove(
        path.dirname(file.absolutePath),
        { recursive: true, force: true },
      );
      if (removed instanceof Error)
        console.warn("Could not remove released attachment:", removed);
      this.uploads.set(file.uploadId, {
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        received: file.size,
        expiry: this.expire(file.uploadId),
      });
    }
  }

  private async cancelUnqueued(uploadId: string) {
    const upload = this.uploads.get(uploadId);
    if (upload === undefined) return;
    clearTimeout(upload.expiry);
    this.uploads.delete(uploadId);
    const removed = await this.filesystem.remove(
      path.join(this.stagingDirectory, uploadId),
      { recursive: true, force: true },
    );
    if (removed instanceof Error)
      return new UploadCleanupError({ fileName: upload.name, cause: removed });
  }

  private stagedPath(uploadId: string, upload: Upload) {
    return path.join(this.stagingDirectory, uploadId, upload.name);
  }

  private expire(uploadId: string) {
    const timer = setTimeout(async () => {
      const cancelled = await this.cancel({ uploadId });
      if (cancelled instanceof Error)
        console.warn("Could not remove an expired upload:", cancelled);
    }, uploadLifetimeMs);
    timer.unref();
    return timer;
  }
}
