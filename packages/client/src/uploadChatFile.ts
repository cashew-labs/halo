import { ORPCError } from "@orpc/client";
import * as errore from "errore";
import { chatAttachmentLimits } from "./chatAttachments.js";
import type { HaloClient } from "./contract.js";

export class ChatUploadError extends errore.createTaggedError({
  name: "ChatUploadError",
  message: "Couldn't upload $fileName. Check your connection and try again.",
}) {}
export class ChatUploadRejectedError extends errore.createTaggedError({
  name: "ChatUploadRejectedError",
  message: "$reason",
}) {}
export class ChatUploadCancelledError extends errore.createTaggedError({
  name: "ChatUploadCancelledError",
  message: "The upload of $fileName was cancelled.",
  extends: errore.AbortError,
}) {}

// Consecutive failed chunks before the upload gives up; the delay doubles each time.
const maxAttempts = 5;
const retryDelayMs = 1000;

/**
 * Uploads a chat attachment in chunks. After a failed chunk it asks the server
 * how much it stored and resumes from there.
 */
export async function uploadChatFile(input: {
  api: HaloClient;
  file: File;
  signal?: AbortSignal;
  onProgress?: (received: number) => void;
}) {
  const { api, file, signal } = input;
  const created = await api.uploads
    .create(
      { name: file.name, size: file.size, mimeType: file.type },
      { signal },
    )
    .catch((cause) => uploadError({ file, signal, cause }));
  if (created instanceof Error) return created;
  const { uploadId } = created;
  let offset = 0;
  let failures = 0;
  while (offset < file.size) {
    const written = await api.uploads
      .write(
        {
          uploadId,
          offset,
          chunk: file.slice(
            offset,
            offset + chatAttachmentLimits.uploadChunkBytes,
          ),
        },
        { signal },
      )
      .catch((cause) => uploadError({ file, signal, cause }));
    if (written instanceof ChatUploadCancelledError) return written;
    if (!(written instanceof Error)) {
      failures = 0;
      offset = written.received;
      input.onProgress?.(offset);
      continue;
    }
    // An offset mismatch is rejected too; the status check below resolves it.
    failures++;
    if (failures >= maxAttempts) return written;
    const waited = await wait({
      milliseconds: retryDelayMs * 2 ** (failures - 1),
      file,
      signal,
    });
    if (waited instanceof Error) return waited;
    const status = await api.uploads
      .status({ uploadId }, { signal })
      .catch((cause) => uploadError({ file, signal, cause }));
    // A rejected status means the server no longer has this upload.
    if (status instanceof ChatUploadCancelledError) return status;
    if (status instanceof ChatUploadRejectedError) return status;
    if (status instanceof Error) continue;
    offset = status.received;
  }
  return { uploadId };
}

function uploadError(input: {
  file: File;
  signal: AbortSignal | undefined;
  cause: unknown;
}) {
  const { file, signal, cause } = input;
  if (signal?.aborted)
    return new ChatUploadCancelledError({ fileName: file.name, cause });
  if (cause instanceof ORPCError && cause.code === "BAD_REQUEST")
    return new ChatUploadRejectedError({ reason: cause.message, cause });
  return new ChatUploadError({ fileName: file.name, cause });
}

async function wait(input: {
  milliseconds: number;
  file: File;
  signal: AbortSignal | undefined;
}) {
  const { signal } = input;
  return await new Promise<void | ChatUploadCancelledError>((resolve) => {
    const cancelled = () =>
      new ChatUploadCancelledError({
        fileName: input.file.name,
        cause: signal?.reason,
      });
    // uploadError() already reports an earlier abort, so this covers only an
    // abort between the failed request and this delay.
    // coverage-exempt: Reachable only through that race.
    if (signal?.aborted) {
      resolve(cancelled());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, input.milliseconds);
    const abort = () => {
      clearTimeout(timer);
      resolve(cancelled());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
