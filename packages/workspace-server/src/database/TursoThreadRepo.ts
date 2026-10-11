// oxlint-disable unicorn/no-null -- SQL uses NULL for an absent read receipt.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Queries project repository-owned tables into matching row types.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { NativeConnection } from "./DatabaseService.js";
import type {
  ThreadHandle,
  ThreadData,
  ThreadMetadata,
  ThreadProductFields,
  ThreadRepoApi,
} from "./ThreadRepoApi.js";
import { TursoStorage } from "./TursoStorage.js";
import { decodeThreadJson, ThreadBackendError } from "./threadSchema.js";

type ThreadProductFieldsRow = {
  id: string;
  marked_done: number;
  read_receipt_cursor_id: string | null;
};
type MetadataRow = { metadata: string };

export class TursoThreadRepo implements ThreadRepoApi {
  private readonly reserved = new Set<string>();
  private readonly storages = new Set<TursoStorage>();
  private closed = false;

  constructor(private readonly database: NativeConnection) {}

  async create(options?: { id?: string }) {
    const createdAt = Date.now();
    const threadId = options?.id ?? uuidv7(createdAt);
    this.reserve(threadId);
    const inserted = await this.database.access((connection) =>
      connection
        .prepare("INSERT INTO halo_threads (id, metadata) VALUES (?, ?)")
        .run(threadId, JSON.stringify({ id: threadId, createdAt })),
    );
    if (inserted instanceof Error) {
      this.reserved.delete(threadId);
      throw inserted;
    }
    return await this.openReserved({ id: threadId, createdAt });
  }

  async open(metadata: ThreadMetadata) {
    this.reserve(metadata.id);
    const loaded = await this.database.access((connection) => {
      const row = connection
        .prepare("SELECT metadata FROM halo_threads WHERE id = ?")
        .get(metadata.id) as MetadataRow | undefined;
      if (row === undefined)
        throw new ThreadBackendError({
          detail: `Unknown thread ${metadata.id}`,
        });
      const persisted = decodeThreadJson<ThreadMetadata>(row.metadata);
      return { id: persisted.id, createdAt: persisted.createdAt };
    });
    if (loaded instanceof Error) {
      this.reserved.delete(metadata.id);
      throw loaded;
    }
    return await this.openReserved(loaded);
  }

  async list() {
    this.assertOpen();
    const listed = await this.database.access((connection) =>
      (
        connection
          .prepare("SELECT metadata FROM halo_threads")
          .all() as MetadataRow[]
      )
        .map(({ metadata }) => decodeThreadJson<ThreadMetadata>(metadata))
        .map(({ id, createdAt }) => ({ id, createdAt }))
        .toSorted((a, b) => b.createdAt - a.createdAt),
    );
    if (listed instanceof Error) throw listed;
    return listed;
  }

  async read(threadId: string): Promise<ThreadData> {
    this.assertOpen();
    return await TursoStorage.readThread({
      database: this.database,
      threadId,
    });
  }

  async listPendingThreadIds() {
    return await this.database.access((connection) =>
      (
        connection
          .prepare(`
        SELECT thread_id FROM tasks WHERE status IN ('pending', 'running', 'waiting', 'completing')
        UNION
        SELECT thread_id FROM submissions WHERE status IN ('queued', 'placed')
      `)
          .all() as { thread_id: string }[]
      ).map((row) => row.thread_id),
    );
  }

  async listProductFields() {
    return await this.database.access(
      (connection) =>
        new Map<string, ThreadProductFields>(
          (
            connection
              .prepare(
                "SELECT id, marked_done, read_receipt_cursor_id FROM halo_threads",
              )
              .all() as ThreadProductFieldsRow[]
          ).map((row) => [row.id, decodeProductFields(row)]),
        ),
    );
  }
  async getProductFields(threadId: string) {
    return await this.database.access((connection) => {
      const row = connection
        .prepare(
          "SELECT id, marked_done, read_receipt_cursor_id FROM halo_threads WHERE id = ?",
        )
        .get(threadId) as ThreadProductFieldsRow | undefined;
      return row === undefined ? undefined : decodeProductFields(row);
    });
  }
  async setMarkedDone(input: { threadId: string; markedDone: boolean }) {
    return await this.database.access((connection) => {
      connection
        .prepare("UPDATE halo_threads SET marked_done = ? WHERE id = ?")
        .run(input.markedDone ? 1 : 0, input.threadId);
    });
  }
  async setReadReceipt(input: {
    threadId: string;
    readReceiptCursorId?: string;
  }) {
    return await this.database.access((connection) => {
      connection
        .prepare(
          "UPDATE halo_threads SET read_receipt_cursor_id = ? WHERE id = ?",
        )
        .run(input.readReceiptCursorId ?? null, input.threadId);
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const closed = await Promise.all(
      [...this.storages].map(
        async (storage) =>
          await storage
            .close(BACKGROUND_CONTEXT)
            .catch(
              (cause) =>
                new ThreadBackendError({ detail: "Close storage", cause }),
            ),
      ),
    );
    return closed.find((item) => item instanceof Error);
  }

  private async openReserved(metadata: ThreadMetadata): Promise<ThreadHandle> {
    const opened = await TursoStorage.open({
      database: this.database,
      threadId: metadata.id,
    }).catch(
      (cause) => new ThreadBackendError({ detail: "Open storage", cause }),
    );
    if (opened instanceof Error) {
      this.reserved.delete(metadata.id);
      throw opened;
    }
    const storage = opened;
    storage.setOnClose(() => {
      this.reserved.delete(metadata.id);
      this.storages.delete(storage);
    });
    this.storages.add(storage);
    return {
      metadata,
      storage,
      fatalCommitErrors: storage.fatalCommitErrors,
      read: async () => await storage.read(),
      close: async () => await storage.close(BACKGROUND_CONTEXT),
    };
  }
  private reserve(threadId: string) {
    this.assertOpen();
    if (this.reserved.has(threadId))
      throw new ThreadBackendError({
        detail: `Thread is already open: ${threadId}`,
      });
    this.reserved.add(threadId);
  }
  private assertOpen() {
    if (this.closed)
      throw new ThreadBackendError({ detail: "Repository is closed" });
  }
}

function decodeProductFields(row: ThreadProductFieldsRow): ThreadProductFields {
  const fields: ThreadProductFields = { markedDone: row.marked_done === 1 };
  if (row.read_receipt_cursor_id !== null)
    fields.readReceiptCursorId = row.read_receipt_cursor_id;
  return fields;
}
