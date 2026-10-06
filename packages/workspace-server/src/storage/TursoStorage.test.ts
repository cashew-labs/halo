import fs from "node:fs/promises";
import path from "node:path";
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Tests construct valid branded durable IDs explicitly.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type ConversationId,
  type DocumentId,
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
