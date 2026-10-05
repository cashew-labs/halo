import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Tests construct valid branded durable IDs explicitly.
import type {
  ConversationId,
  DocumentId,
  EntryId,
  StorageWrite,
  SubmissionId,
} from "@earendil-works/pi-durable";
import { expect } from "vitest";
import { piBackendTest } from "./fixtures.test.js";

piBackendTest(
  "creates, lists, reserves, closes, and reopens a thread",
  async ({ piBackend }) => {
    const created = await piBackend.repo.create({ id: "thread-1" });
    expect(created.metadata).toMatchObject({ id: "thread-1" });
    expect(await piBackend.repo.list()).toEqual([created.metadata]);
    await expect(piBackend.repo.open(created.metadata)).rejects.toThrow(
      "already open",
    );
    await created.close();
    const reopened = await piBackend.repo.open(created.metadata);
    expect(reopened.metadata).toEqual(created.metadata);
    await reopened.close();
  },
);

piBackendTest(
  "isolates simultaneous durable threads sharing one database",
  async ({ piBackend }) => {
    const first = await piBackend.repo.create({ id: "thread-a" });
    const second = await piBackend.repo.create({ id: "thread-b" });
    // SAFETY: These are valid positive durable IDs chosen explicitly to verify cross-thread reuse.
    const rootId = 1 as ConversationId;
    // SAFETY: These are valid positive durable IDs chosen explicitly to verify cross-thread reuse.
    const submissionId = 2 as SubmissionId;
    // SAFETY: These are valid positive durable IDs chosen explicitly to verify cross-thread reuse.
    const documentId = 3 as DocumentId;
    const writes = (label: string): readonly StorageWrite[] => [
      { type: "conversation", value: { id: rootId } },
      {
        type: "submission",
        value: {
          id: submissionId,
          conversationId: rootId,
          requestId: "same-request",
          type: "input",
          status: "queued",
        },
      },
      {
        type: "document.create",
        record: {
          id: documentId,
          kind: "isolation",
          scope: { kind: "session" },
        },
        content: { kind: "base", version: 1, value: { label } },
      },
    ];

    await Promise.all([
      first.storage.commit(writes("first"), BACKGROUND_CONTEXT),
      second.storage.commit(writes("second"), BACKGROUND_CONTEXT),
    ]);

    expect(
      await first.storage.conversation(rootId, BACKGROUND_CONTEXT),
    ).toEqual({
      id: rootId,
    });
    expect(
      await second.storage.conversation(rootId, BACKGROUND_CONTEXT),
    ).toEqual({
      id: rootId,
    });
    expect(
      await first.storage.submissionByRequest(
        rootId,
        "same-request",
        BACKGROUND_CONTEXT,
      ),
    ).toMatchObject({ id: submissionId, requestId: "same-request" });
    expect(
      await second.storage.submissionByRequest(
        rootId,
        "same-request",
        BACKGROUND_CONTEXT,
      ),
    ).toMatchObject({ id: submissionId, requestId: "same-request" });
    expect(
      await first.storage.document(documentId, "current", BACKGROUND_CONTEXT),
    ).toMatchObject({ value: { label: "first" } });
    expect(
      await second.storage.document(documentId, "current", BACKGROUND_CONTEXT),
    ).toMatchObject({ value: { label: "second" } });

    await Promise.all([first.close(), second.close()]);
  },
);

piBackendTest(
  "reads the canonical root history, materialized documents, and latest settled run",
  async ({ piBackend }) => {
    const handle = await piBackend.repo.create({ id: "read-thread" });
    const rootId = 1 as ConversationId;
    const firstSubmissionId = 10 as SubmissionId;
    const secondSubmissionId = 20 as SubmissionId;
    const rejectedSubmissionId = 30 as SubmissionId;
    const queuedSubmissionId = 40 as SubmissionId;
    const laterEntryId = 100 as EntryId;
    const earlierEntryId = 50 as EntryId;
    const piLiveId = 200 as DocumentId;
    const haloSessionId = 201 as DocumentId;

    await handle.storage.commit(
      [
        { type: "conversation", value: { id: rootId } },
        {
          type: "entry",
          value: {
            id: laterEntryId,
            conversationId: rootId,
            kind: "user",
            data: { text: "allocated first" },
          },
        },
        {
          type: "entry",
          value: {
            id: earlierEntryId,
            conversationId: rootId,
            kind: "user",
            data: { text: "chronologically first" },
          },
        },
        {
          type: "submission",
          value: {
            id: firstSubmissionId,
            conversationId: rootId,
            type: "input",
            status: "placed",
            entry: laterEntryId,
          },
        },
        {
          type: "submission",
          value: {
            id: secondSubmissionId,
            conversationId: rootId,
            type: "input",
            status: "placed",
            entry: earlierEntryId,
          },
        },
        {
          type: "document.create",
          record: {
            id: piLiveId,
            kind: "pi.live",
            scope: { kind: "conversation", conversationId: rootId },
            history: "latest",
            fork: "initial",
          },
          content: { kind: "base", version: 1, value: { count: 1 } },
        },
        {
          type: "document.create",
          record: {
            id: haloSessionId,
            kind: "halo.thread",
            scope: { kind: "conversation", conversationId: rootId },
            history: "latest",
            fork: "initial",
          },
          content: { kind: "base", version: 1, value: { name: "Before" } },
        },
      ],
      BACKGROUND_CONTEXT,
    );

    const firstDone = {
      id: firstSubmissionId,
      conversationId: rootId,
      type: "input" as const,
      status: "done" as const,
      entry: laterEntryId,
      answer: 101 as EntryId,
    };
    const secondDone = {
      id: secondSubmissionId,
      conversationId: rootId,
      type: "input" as const,
      status: "done" as const,
      entry: earlierEntryId,
      answer: 51 as EntryId,
    };
    await handle.storage.commit(
      [
        { type: "submission", value: firstDone },
        { type: "submission", value: secondDone },
        {
          type: "document.change",
          id: piLiveId,
          content: {
            kind: "delta",
            version: 1,
            ops: [["s", ["count"], 2]],
          },
        },
        {
          type: "document.change",
          id: haloSessionId,
          content: {
            kind: "delta",
            version: 1,
            ops: [["s", ["name"], "After"]],
          },
        },
      ],
      BACKGROUND_CONTEXT,
    );
    await handle.storage.commit(
      [
        { type: "submission", value: firstDone },
        {
          type: "submission",
          value: {
            id: rejectedSubmissionId,
            conversationId: rootId,
            type: "input",
            status: "unanswered",
            reason: "rejected before placement",
          },
        },
        {
          type: "submission",
          value: {
            id: queuedSubmissionId,
            conversationId: rootId,
            type: "input",
            status: "queued",
          },
        },
      ],
      BACKGROUND_CONTEXT,
    );

    const fromHandle = await handle.read();
    expect(fromHandle).toMatchObject({
      seq: 3,
      entries: [{ id: earlierEntryId }, { id: laterEntryId }],
      submissions: [
        { id: firstSubmissionId, status: "done" },
        { id: secondSubmissionId, status: "done" },
        { id: rejectedSubmissionId, status: "unanswered" },
        { id: queuedSubmissionId, status: "queued" },
      ],
      documents: {
        "pi.live": { count: 2 },
        "halo.thread": { name: "After" },
      },
      lastRun: secondDone,
    });
    expect(await piBackend.repo.read(handle.metadata.id)).toEqual(fromHandle);
  },
);
