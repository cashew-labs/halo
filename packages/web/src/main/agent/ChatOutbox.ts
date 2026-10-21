import * as errore from "errore";
import { ORPCError } from "@orpc/client";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import { Stream } from "@get-halo/shared/Stream";
import type { ChatReference, HaloClient } from "@get-halo/client";
import { ChatUploads } from "./ChatUploads.js";

type OutboxDraft = {
  text: string;
  attachmentIds: string[];
  files: File[];
  references: ChatReference[];
};

export type OutboxMessage = {
  /** The client message ID the server records with the message. */
  messageId: string;
  sessionId: string;
  draft: OutboxDraft;
  /** When the message was queued, to order it among the session's messages. */
  queuedAt: number;
  /**
   * `waiting` for uploads, `sending` the prompt, `sent` but not yet in the
   * session, or `returned` because it could not be sent.
   */
  state: "waiting" | "sending" | "sent" | "returned";
  submissionId: number | undefined;
  error: string | undefined;
};

const noAttachments: readonly string[] = [];

class OutboxSendError extends errore.createTaggedError({
  name: "OutboxSendError",
  message: "$reason",
}) {}

/**
 * Sends chat messages once their attachments finish uploading. It belongs to
 * the workspace connection, not a chat pane, so a waiting message still sends
 * after its pane closes or shows another session.
 */
export class ChatOutbox {
  readonly uploads: ChatUploads;
  private readonly changes = new Stream<readonly OutboxMessage[]>();
  /** Messages that the session has not shown yet, oldest first. */
  readonly state = this.changes.project<readonly OutboxMessage[]>(
    [],
    (_previous, next) => next,
  );
  private readonly draftChanges = new Stream<
    ReadonlyMap<string, readonly string[]>
  >();
  /**
   * Attachment IDs in each composer, by session or draft ID. They outlive the
   * pane, as the draft text does.
   */
  readonly drafts = this.draftChanges.project<
    ReadonlyMap<string, readonly string[]>
  >(new Map(), (_previous, next) => next);
  // Sends each session's messages in the order they were queued.
  private readonly queues = new Map<string, SerialQueue>();
  // Stops each waiting message, by message ID, when it leaves the queue.
  private readonly controllers = new Map<string, AbortController>();
  // The connection's current client; reconnecting replaces it.
  private api: HaloClient;

  constructor(ctx: { api: HaloClient }) {
    const { api } = ctx;
    this.api = api;
    this.uploads = new ChatUploads({ api });
  }

  setApi(api: HaloClient) {
    this.api = api;
    this.uploads.setApi(api);
  }

  draftAttachments(composerId: string) {
    return this.drafts.latestValue.get(composerId) ?? noAttachments;
  }

  setDraftAttachments(composerId: string, attachmentIds: readonly string[]) {
    const next = new Map(this.drafts.latestValue);
    if (attachmentIds.length === 0) next.delete(composerId);
    else next.set(composerId, attachmentIds);
    this.draftChanges.append(next);
  }

  /** Queues a message that sends once its attachments upload. */
  enqueue(input: {
    messageId: string;
    sessionId: string;
    draft: OutboxDraft;
    queuedAt: number;
  }) {
    const controller = new AbortController();
    this.controllers.set(input.messageId, controller);
    this.changes.append([
      ...this.state.latestValue,
      { ...input, state: "waiting", submissionId: undefined, error: undefined },
    ]);
    const queue = this.queues.get(input.sessionId) ?? new SerialQueue();
    this.queues.set(input.sessionId, queue);
    queue
      .run(async () => await this.send(input.messageId, controller.signal))
      .finally(() => this.controllers.delete(input.messageId))
      .catch(
        (cause) => console.error("Failed to send a waiting message:", cause), // coverage-exempt: send() returns errors as values; this logs only an unexpected exception.
      );
  }

  /** Takes back a waiting message before it starts sending. */
  withdraw(messageId: string) {
    const message = this.find(messageId);
    if (message?.state !== "waiting") return undefined;
    this.controllers.get(messageId)?.abort();
    this.changes.append(
      this.state.latestValue.filter(
        (candidate) => candidate.messageId !== messageId,
      ),
    );
    return message;
  }

  /** Takes back a session's messages that could not be sent, oldest first. */
  takeReturned(sessionId: string) {
    const returned = this.state.latestValue.filter(
      (message) =>
        message.sessionId === sessionId && message.state === "returned",
    );
    if (returned.length > 0)
      this.changes.append(
        this.state.latestValue.filter((message) => !returned.includes(message)),
      );
    return returned;
  }

  /** Drops sent messages that the session now shows or that Stop withdrew. */
  forget(messageIds: Iterable<string | undefined>) {
    const forgotten = new Set(messageIds);
    const kept = this.state.latestValue.filter(
      (message) =>
        message.state !== "sent" || !forgotten.has(message.messageId),
    );
    if (kept.length !== this.state.latestValue.length)
      this.changes.append(kept);
  }

  /** Stops every waiting message and upload. */
  close() {
    for (const controller of this.controllers.values()) controller.abort();
    this.uploads.close();
  }

  private async send(messageId: string, signal: AbortSignal) {
    const message = this.find(messageId);
    if (message === undefined || signal.aborted) return;
    const uploadIds = await this.uploads.uploadIds(
      message.draft.attachmentIds,
      signal,
    );
    // The message went back to the draft, or the workspace closed.
    if (errore.isAbortError(uploadIds) || signal.aborted) return;
    this.update(messageId, { state: "sending" });
    const result =
      uploadIds instanceof Error
        ? uploadIds
        : await this.api.thread
            .prompt({
              sessionId: message.sessionId,
              text: message.draft.text.trim(),
              uploadIds,
              references: message.draft.references,
              clientMessageId: messageId,
            })
            .catch(
              (cause) =>
                new OutboxSendError({
                  reason:
                    cause instanceof ORPCError && cause.code === "BAD_REQUEST"
                      ? cause.message
                      : "Couldn't send your message. Please try again.",
                  cause,
                }),
            );
    if (result instanceof Error) {
      console.warn("Failed to send a waiting message:", result);
      this.returnFrom(message, result.message);
      return;
    }
    this.uploads.consume(message.draft.attachmentIds);
    this.update(messageId, {
      state: "sent",
      submissionId: result.submissionId,
    });
  }

  // Later messages stay behind a failed one, so they return to the draft too.
  private returnFrom(failed: OutboxMessage, error: string) {
    const later = this.state.latestValue.filter(
      (message) =>
        message.sessionId === failed.sessionId && message.state === "waiting",
    );
    for (const message of later)
      this.controllers.get(message.messageId)?.abort();
    this.changes.append(
      this.state.latestValue.map((message) => {
        if (message.messageId === failed.messageId)
          return { ...message, state: "returned", error };
        if (later.includes(message)) return { ...message, state: "returned" };
        return message;
      }),
    );
  }

  private find(messageId: string) {
    return this.state.latestValue.find(
      (message) => message.messageId === messageId,
    );
  }

  private update(messageId: string, change: Partial<OutboxMessage>) {
    this.changes.append(
      this.state.latestValue.map((message) =>
        message.messageId === messageId ? { ...message, ...change } : message,
      ),
    );
  }
}
