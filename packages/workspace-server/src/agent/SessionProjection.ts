import {
  defineDoc,
  type CommitPublication,
  type EntryRecord,
  type LiveState,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { JsonRepresentation } from "@earendil-works/chord";
import {
  chatPromptTitle,
  type HaloMessage,
  type SessionSnapshot,
  type SessionSummary,
} from "@get-halo/client";
import type { ThreadData, ThreadMetadata } from "../storage/ThreadRepoApi.js";
import { sessionEntry, sessionSnapshot } from "./sessionEvents.js";

export type MessagePresentation =
  | Omit<Extract<HaloMessage, { role: "user" }>, "content">
  | Omit<Extract<HaloMessage, { role: "custom" }>, "content">;

export const HaloThreadDoc = defineDoc<{
  name?: string;
  inputs: Record<string, JsonRepresentation<MessagePresentation>>;
}>({
  kind: "halo.thread",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ inputs: {} }),
});

/** One read-only projection shared by live sessions and saved-conversation search. */
export class SessionProjection {
  private seq: number;
  private readonly entries = new Map<number, EntryRecord>();
  private readonly submissions = new Map<number, SubmissionRecord>();
  private documents: ThreadData["documents"];
  private lastRun: SessionSnapshot["lastRun"];

  constructor(data: ThreadData) {
    this.seq = data.seq;
    for (const entry of data.entries) this.entries.set(entry.id, entry);
    for (const submission of data.submissions)
      this.submissions.set(submission.id, submission);
    this.documents = data.documents;
    this.lastRun = completedRun(data.lastRun);
  }

  apply(publication: CommitPublication) {
    if (publication.seq <= this.seq) return;
    const settled: SubmissionRecord[] = [];
    for (const change of publication.changes) {
      if (change.type === "entry" && change.value.conversationId === 1)
        this.entries.set(change.value.id, change.value);
      if (change.type === "submission" && change.value.conversationId === 1) {
        const previous = this.submissions.get(change.value.id);
        this.submissions.set(change.value.id, change.value);
        if (
          change.value.type === "input" &&
          change.value.entry !== undefined &&
          (change.value.status === "done" ||
            change.value.status === "unanswered") &&
          previous?.status !== "done" &&
          previous?.status !== "unanswered"
        )
          settled.push(change.value);
      }
      if (
        change.type === "document" &&
        change.conversationId === 1 &&
        change.value !== null
      )
        this.documents = {
          ...this.documents,
          [change.record.kind]: change.value,
        };
    }
    // Pi settles a run's placed inputs atomically. Placement order, not admission order, identifies its first input.
    const first = settled.toSorted((a, b) => a.entry! - b.entry!)[0];
    if (first !== undefined) this.lastRun = completedRun(first);
    this.seq = publication.seq;
  }

  get name() {
    return this.presentation.name;
  }

  private get presentation() {
    // SAFETY: HaloThreadDoc is the only writer of this application document.
    return (this.documents["halo.thread"] ?? { inputs: {} }) as {
      name?: string;
      inputs: Record<string, MessagePresentation>;
    };
  }

  snapshot(): SessionSnapshot {
    const byEntry = new Map(
      [...this.submissions.values()]
        .filter((item) => item.entry !== undefined)
        .map((item) => [item.entry, item.requestId]),
    );
    const state = this.presentation;
    const entries = [...this.entries.values()].flatMap((entry) => {
      const requestId = byEntry.get(entry.id);
      const mapped = sessionEntry(
        entry,
        requestId === undefined ? undefined : state.inputs[requestId],
      );
      return mapped === undefined ? [] : [mapped];
    });
    // SAFETY: Pi owns pi.live and publishes LiveState revisions.
    const live = (this.documents["pi.live"] ?? {}) as LiveState;
    return sessionSnapshot({
      live,
      entries,
      lastRun: this.lastRun,
      connections: [],
    });
  }

  summary(input: {
    metadata: ThreadMetadata;
    cwd: string;
    snapshot: SessionSnapshot;
  }): Omit<SessionSummary, "markedDone" | "readReceiptCursorId"> {
    const { metadata, cwd, snapshot } = input;
    const latest = snapshot.entries.at(-1);
    const timestamp =
      latest?.type === "message" ? latest.message.timestamp : latest?.timestamp;
    return {
      sessionId: metadata.id,
      agent: "pi",
      cwd,
      title: this.title(snapshot).trim() || undefined,
      isRunning: snapshot.activeRun !== undefined,
      latestResultId:
        snapshot.lastRun?.id ??
        snapshot.entries.findLast(
          (entry) =>
            entry.type === "message" && entry.message.role === "assistant",
        )?.id,
      createdAt: new Date(metadata.createdAt).toISOString(),
      updatedAt: new Date(timestamp ?? metadata.createdAt).toISOString(),
    };
  }

  title(snapshot: SessionSnapshot) {
    const first = snapshot.entries.find(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    const message =
      first?.type === "message" && first.message.role === "user"
        ? first.message
        : undefined;
    return (
      this.name ??
      (message === undefined
        ? ""
        : chatPromptTitle({
            text:
              message.displayText ??
              (Array.isArray(message.content)
                ? message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n")
                : message.content),
            files: message.attachments,
            references: message.references,
          }))
    );
  }
}

function completedRun(
  submission: SubmissionRecord | undefined,
): SessionSnapshot["lastRun"] {
  if (submission?.status !== "done" && submission?.status !== "unanswered")
    return;
  return {
    id: String(submission.id),
    status:
      submission.status === "done"
        ? "completed"
        : submission.reason === "aborted"
          ? "aborted"
          : "failed",
    error: submission.status === "unanswered" ? submission.reason : undefined,
  };
}
