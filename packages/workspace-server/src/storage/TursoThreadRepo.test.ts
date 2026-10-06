import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Tests construct valid branded durable IDs explicitly.
import type {
  ConversationId,
  DocumentId,
  StorageWrite,
  SubmissionId,
} from "@earendil-works/pi-durable";
import { expect } from "vitest";
import { piBackendTest } from "./fixtures.test.js";

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
