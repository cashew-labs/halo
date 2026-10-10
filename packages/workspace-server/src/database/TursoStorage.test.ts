import fs from "node:fs/promises";
import path from "node:path";
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Tests construct valid branded durable IDs explicitly.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  StorageRejected,
  type ConversationId,
  type DocumentId,
  type TaskId,
  type TaskState,
  type TaskRecord,
  type SubmissionId,
  type SubmissionRecord,
  type EntryId,
} from "@earendil-works/pi-durable";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { describe, expect, it } from "vitest";
import { FilesystemService } from "../filesystem/FilesystemService.js";
import { DatabaseClient } from "./DatabaseClient.js";
import { piBackendTest } from "./fixtures.test.js";
import { TursoThreadRepo } from "./TursoThreadRepo.js";

registerStorageConformance(
  { describe, expect, it },
  "TursoStorage",
  async (use) => {
    const parent = path.resolve(
      import.meta.dirname,
      "../../../../tmp/piBackend",
    );
    await fs.mkdir(parent, { recursive: true });
    const directory = await fs.mkdtemp(path.join(parent, "conformance-"));
    const filesystem = new FilesystemService();
    const database = await DatabaseClient.open({ directory, filesystem });
    if (database instanceof Error) throw database;
    const repo = new TursoThreadRepo(database);
    const handle = await repo.create();

    await use(handle.storage);

    const repoClosed = await repo.close();
    const databaseClosed = await database.close();
    const filesystemClosed = await filesystem.close();
    await fs.rm(directory, { recursive: true, force: true });
    if (repoClosed instanceof Error) throw repoClosed;
    if (databaseClosed instanceof Error) throw databaseClosed;
    if (filesystemClosed instanceof Error) throw filesystemClosed;
  },
);

piBackendTest(
  "drains admitted commits before releasing a session",
  async ({ piBackend }) => {
    const handle = await piBackend.repo.create();
    const finished: string[] = [];
    const committing = handle.storage
      .commit(
        [{ type: "conversation", value: { id: 1 as ConversationId } }],
        BACKGROUND_CONTEXT,
      )
      .then(() => finished.push("commit"));
    const closing = handle.close().then(() => finished.push("close"));
    await closing;
    expect(finished).toEqual(["commit", "close"]);
    await committing;
    const reopened = await piBackend.repo.open(handle.metadata);
    expect(
      await reopened.storage.conversation(
        1 as ConversationId,
        BACKGROUND_CONTEXT,
      ),
    ).toEqual({ id: 1 });
  },
);

piBackendTest(
  "reports fatal commit failures through the session handle and preserves the rejection",
  async ({ piBackend }) => {
    const handle = await piBackend.repo.create();
    const fatalErrors: Error[] = [];
    const unsubscribe = handle.fatalCommitErrors.subscribe((error) =>
      fatalErrors.push(error),
    );
    const conversationId = 1 as ConversationId;
    await handle.storage.commit(
      [{ type: "conversation", value: { id: conversationId } }],
      BACKGROUND_CONTEXT,
    );

    const transactionFailure = await handle.storage
      .commit(
        [{ type: "conversation", value: { id: conversationId } }],
        BACKGROUND_CONTEXT,
      )
      .catch((error: Error) => error);
    expect(transactionFailure).toBe(fatalErrors[0]);

    const documentId = 2 as DocumentId;
    const synchronousFailure = await handle.storage
      .commit(
        [
          {
            type: "document.create",
            record: {
              id: documentId,
              kind: "duplicate",
              scope: { kind: "session" },
            },
            content: { kind: "base", version: 1, value: {} },
          },
          {
            type: "document.create",
            record: {
              id: documentId,
              kind: "duplicate",
              scope: { kind: "session" },
            },
            content: { kind: "base", version: 1, value: {} },
          },
        ],
        BACKGROUND_CONTEXT,
      )
      .catch((error: Error) => error);
    expect(synchronousFailure).toBe(fatalErrors[1]);
    expect(fatalErrors).toHaveLength(2);
    unsubscribe();
  },
);

piBackendTest(
  "finds unfinished threads including background tasks and passive writes",
  async ({ piBackend }) => {
    const conversationId = 1 as ConversationId;
    const taskId = 2 as TaskId<Record<string, never>>;
    const taskStates: TaskState<
      Record<string, never>,
      Record<string, never>
    >[] = [
      { status: "pending", checkpoint: {} },
      { status: "running", checkpoint: {} },
      { status: "waiting", checkpoint: {}, on: [], policy: "allSettled" },
      { status: "completing", outcome: { status: "completed", result: {} } },
      { status: "terminal", outcome: { status: "completed", result: {} } },
    ];
    const taskThreads: string[] = [];
    for (const state of taskStates) {
      const handle = await piBackend.repo.create();
      taskThreads.push(handle.metadata.id);
      await handle.storage.commit(
        [
          { type: "conversation", value: { id: conversationId } },
          {
            type: "task",
            value: {
              id: taskId,
              conversationId,
              kind: "maintenance",
              version: 1,
              input: {},
              background: true,
              abortRequested: false,
              state,
            } as TaskRecord<
              Record<string, never>,
              Record<string, never>,
              Record<string, never>
            >,
          },
        ],
        BACKGROUND_CONTEXT,
      );
    }
    const id = 3 as SubmissionId;
    const entry = 4 as EntryId;
    const submissions: SubmissionRecord[] = [
      { id, conversationId, type: "write", status: "queued" },
      { id, conversationId, type: "input", status: "placed", entry },
      {
        id,
        conversationId,
        type: "input",
        status: "done",
        entry,
        answer: entry,
      },
      {
        id,
        conversationId,
        type: "input",
        status: "unanswered",
        reason: "aborted",
      },
    ];
    const submissionThreads: string[] = [];
    for (const submission of submissions) {
      const handle = await piBackend.repo.create();
      submissionThreads.push(handle.metadata.id);
      await handle.storage.commit(
        [
          { type: "conversation", value: { id: conversationId } },
          {
            type: "entry",
            value: { id: entry, conversationId, kind: "message" },
          },
          { type: "submission", value: submission },
        ],
        BACKGROUND_CONTEXT,
      );
    }
    await piBackend.repo.create(); // Empty threads also stay closed.
    expect(await piBackend.repo.listPendingThreadIds()).toEqual(
      [...taskThreads.slice(0, 4), ...submissionThreads.slice(0, 2)].toSorted(),
    );
  },
);

piBackendTest(
  "does not report rejected commits as fatal",
  async ({ piBackend }) => {
    const handle = await piBackend.repo.create();
    const fatalErrors: Error[] = [];
    const unsubscribe = handle.fatalCommitErrors.subscribe((error) =>
      fatalErrors.push(error),
    );
    const sourceId = 2 as DocumentId;
    const copyId = 3 as DocumentId;

    const rejected = await handle.storage
      .commit(
        [
          {
            type: "document.create",
            record: {
              id: sourceId,
              kind: "copy",
              scope: { kind: "session" },
            },
            content: { kind: "base", version: 1, value: {} },
          },
          {
            type: "document.copy",
            record: {
              id: copyId,
              kind: "copy",
              scope: { kind: "session" },
            },
            source: { id: sourceId, at: "current" },
          },
        ],
        BACKGROUND_CONTEXT,
      )
      .catch((error: Error) => error);

    expect(rejected).toBeInstanceOf(StorageRejected);
    expect(fatalErrors).toEqual([]);
    unsubscribe();
  },
);
