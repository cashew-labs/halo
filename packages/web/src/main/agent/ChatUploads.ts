import * as errore from "errore";
import { Stream } from "@get-halo/shared/Stream";
import { uploadChatFile, type HaloClient } from "@get-halo/client";

export type ChatUpload = {
  file: File;
  received: number;
  state: "uploading" | "uploaded" | "failed";
  uploadId: string | undefined;
  error: string | undefined;
};

export class ChatUploadFailedError extends errore.createTaggedError({
  name: "ChatUploadFailedError",
  message: "$reason",
}) {}
export class ChatUploadWaitCancelledError extends errore.createTaggedError({
  name: "ChatUploadWaitCancelledError",
  message: "Stopped waiting for attachments to upload.",
  extends: errore.AbortError,
}) {}

// More parallel uploads would compete for the same connection.
const concurrentUploads = 3;

/**
 * Uploads a chat pane's attachments as soon as they are added, so a message
 * can be sent before they finish. Attachments are identified by a local
 * attachment ID until the server accepts the message that sends them.
 */
export class ChatUploads {
  private readonly changes = new Stream<ReadonlyMap<string, ChatUpload>>();
  /** Every attachment that has not been sent or removed, by attachment ID. */
  readonly state = this.changes.project<ReadonlyMap<string, ChatUpload>>(
    new Map(),
    (_previous, next) => next,
  );
  // Aborts the in-flight upload for each attachment ID.
  private readonly controllers = new Map<string, AbortController>();
  // Attachment IDs waiting for an upload slot, oldest first.
  private readonly queued: string[] = [];
  // The connection's current client; reconnecting replaces it.
  private api: HaloClient;

  constructor(ctx: { api: HaloClient }) {
    const { api } = ctx;
    this.api = api;
  }

  setApi(api: HaloClient) {
    this.api = api;
  }

  add(files: readonly File[]) {
    const attachmentIds = files.map(() => crypto.randomUUID());
    const next = new Map(this.state.latestValue);
    for (const [index, file] of files.entries())
      next.set(attachmentIds[index]!, {
        file,
        received: 0,
        state: "uploading",
        uploadId: undefined,
        error: undefined,
      });
    this.changes.append(next);
    this.queued.push(...attachmentIds);
    this.startQueued();
    return attachmentIds;
  }

  retry(attachmentId: string) {
    const upload = this.state.latestValue.get(attachmentId);
    if (upload?.state !== "failed") return;
    this.update(attachmentId, {
      received: 0,
      state: "uploading",
      error: undefined,
    });
    this.queued.push(attachmentId);
    this.startQueued();
  }

  /** Waits for the attachments to finish uploading and returns their upload IDs. */
  async uploadIds(attachmentIds: readonly string[], signal?: AbortSignal) {
    using cleanup = new errore.DisposableStack();
    return await new Promise<
      string[] | ChatUploadFailedError | ChatUploadWaitCancelledError
    >((resolve) => {
      const cancel = () =>
        resolve(new ChatUploadWaitCancelledError({ cause: signal?.reason }));
      if (signal?.aborted) {
        cancel();
        return;
      }
      signal?.addEventListener("abort", cancel, { once: true });
      cleanup.defer(() => signal?.removeEventListener("abort", cancel));
      cleanup.defer(
        this.state.subscribe((uploads) => {
          const uploadIds = settledUploadIds(attachmentIds, uploads);
          if (uploadIds !== undefined) resolve(uploadIds);
        }),
      );
    });
  }

  /** Forgets attachments whose message the server accepted. */
  consume(attachmentIds: readonly string[]) {
    const next = new Map(this.state.latestValue);
    for (const attachmentId of attachmentIds) next.delete(attachmentId);
    this.changes.append(next);
  }

  /** Stops and deletes attachments that will not be sent. */
  remove(attachmentIds: readonly string[]) {
    const removed = attachmentIds.flatMap((attachmentId) => {
      const upload = this.state.latestValue.get(attachmentId);
      return upload === undefined ? [] : [upload];
    });
    for (const attachmentId of attachmentIds)
      this.controllers.get(attachmentId)?.abort();
    this.consume(attachmentIds);
    for (const upload of removed)
      if (upload.uploadId !== undefined) this.cancel(upload.uploadId);
  }

  /** Stops every upload. The server deletes their staged files. */
  close() {
    this.queued.length = 0;
    this.remove([...this.state.latestValue.keys()]);
  }

  private startQueued() {
    while (
      this.controllers.size < concurrentUploads &&
      this.queued.length > 0
    ) {
      const attachmentId = this.queued.shift()!;
      const upload = this.state.latestValue.get(attachmentId);
      if (upload?.state !== "uploading") continue;
      const controller = new AbortController();
      this.controllers.set(attachmentId, controller);
      this.upload({ attachmentId, file: upload.file, controller }).catch(
        (cause) => console.error("Chat upload stopped unexpectedly:", cause), // coverage-exempt: upload() returns errors as values; this logs only an unexpected exception.
      );
    }
  }

  private async upload(input: {
    attachmentId: string;
    file: File;
    controller: AbortController;
  }) {
    const { attachmentId, controller } = input;
    const uploaded = await uploadChatFile({
      api: this.api,
      file: input.file,
      signal: controller.signal,
      onProgress: (received) => {
        if (!controller.signal.aborted) this.update(attachmentId, { received });
      },
    });
    this.controllers.delete(attachmentId);
    this.startQueued();
    // A removed attachment cancelled its own upload.
    if (errore.isAbortError(uploaded)) return;
    if (uploaded instanceof Error) {
      console.warn("Chat upload failed:", uploaded);
      this.update(attachmentId, { state: "failed", error: uploaded.message });
      return;
    }
    if (!this.state.latestValue.has(attachmentId)) {
      this.cancel(uploaded.uploadId);
      return;
    }
    this.update(attachmentId, {
      state: "uploaded",
      uploadId: uploaded.uploadId,
      received: input.file.size,
    });
  }

  private update(attachmentId: string, change: Partial<ChatUpload>) {
    const upload = this.state.latestValue.get(attachmentId);
    if (upload === undefined) return;
    this.changes.append(
      new Map(this.state.latestValue).set(attachmentId, {
        ...upload,
        ...change,
      }),
    );
  }

  private cancel(uploadId: string) {
    this.api.uploads
      .cancel({ uploadId })
      .catch((cause) => console.warn("Could not cancel upload:", cause));
  }
}

function settledUploadIds(
  attachmentIds: readonly string[],
  uploads: ReadonlyMap<string, ChatUpload>,
) {
  const selected = attachmentIds.map((attachmentId) =>
    uploads.get(attachmentId),
  );
  if (selected.includes(undefined))
    return new ChatUploadFailedError({
      reason: "An attachment was removed before it was sent.",
    });
  const failed = selected.find((upload) => upload?.state === "failed");
  if (failed !== undefined)
    return new ChatUploadFailedError({
      reason: failed.error ?? `Couldn't upload ${failed.file.name}.`,
    });
  const uploadIds = selected.map((upload) => upload?.uploadId);
  if (uploadIds.includes(undefined)) return undefined;
  // SAFETY: Every selected attachment has an upload ID, checked above.
  return uploadIds as string[];
}
