import {
  StorageBackedSession,
  createForkSnapshot,
  value,
  type Session,
  type SessionMetadata,
  type SessionRepo,
  type SessionCreateOptions,
  type ForkOptions,
  type Entry,
  type StoredValue,
  type CommittedWrite,
} from "@earendil-works/pi-agent-core/harness/session";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { Database } from "@tursodatabase/database/compat";
import * as errore from "errore";
import type { DatabaseClient } from "./DatabaseClient.js";
import { TursoStorage, applySessionWrites } from "./TursoStorage.js";
import {
  decodeSessionJson,
  sessionSchema,
  emptySessionStats,
  readSessionRow,
  SessionBackendError,
} from "./sessionSchema.js";

export class TursoSessionRepo implements SessionRepo {
  private readonly reserved = new Set<string>();
  private readonly sessions = new Set<Session>();
  private closed = false;

  private constructor(private readonly database: DatabaseClient) {}

  static async open(database: DatabaseClient) {
    const initialized = await database.access((connection) =>
      connection.transaction(() => connection.exec(sessionSchema))(),
    );
    if (initialized instanceof Error) return initialized;
    return new TursoSessionRepo(database);
  }

  async create(options: SessionCreateOptions | undefined) {
    const createdAt = Date.now();
    const id = options?.id === undefined ? uuidv7(createdAt) : options.id;
    return await this.openSession(id, (connection) => {
      const metadata: SessionMetadata = {
        id,
        createdAt,
        storageVersion: 1,
      };
      if (options?.parentSessionId !== undefined)
        metadata.parentSessionId = options.parentSessionId;
      connection
        .prepare(
          "INSERT INTO halo_sessions (id, metadata, next_seq, stats) VALUES (?, ?, ?, ?)",
        )
        .run(
          id,
          JSON.stringify(metadata),
          1,
          JSON.stringify(emptySessionStats()),
        );
      return metadata;
    });
  }

  async open(metadata: SessionMetadata) {
    return await this.openSession(
      metadata.id,
      (connection) => readSessionRow(connection, metadata.id).metadata,
    );
  }

  async list() {
    this.assertOpen();
    const result = await this.database.access((connection) => {
      // SAFETY: The projection matches the session schema initialized by this repository.
      const rows = connection
        .prepare("SELECT metadata FROM halo_sessions")
        .all() as { metadata: string }[];
      return rows
        .map((row) => decodeSessionJson<SessionMetadata>(row.metadata))
        .toSorted((a, b) => b.createdAt - a.createdAt);
    });
    if (result instanceof Error) throw result;
    return result;
  }

  async delete(metadata: SessionMetadata) {
    this.reserve(metadata.id);
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => this.reserved.delete(metadata.id));
    const removed = await this.database.access((connection) =>
      connection.transaction(() => {
        readSessionRow(connection, metadata.id);
        connection
          .prepare("DELETE FROM halo_sessions WHERE id = ?")
          .run(metadata.id);
      })(),
    );
    if (removed instanceof Error) throw removed;
  }

  async fork(source: SessionMetadata, options: ForkOptions) {
    const createdAt = Date.now();
    const id = options.id === undefined ? uuidv7(createdAt) : options.id;
    return await this.openSession(id, (connection) => {
      readSessionRow(connection, source.id);
      // SAFETY: The projection matches the session schema initialized by this repository.
      const entryRows = connection
        .prepare(
          "SELECT payload FROM halo_session_entries WHERE session_id = ? ORDER BY seq",
        )
        .all(source.id) as { payload: string }[];
      // SAFETY: The projection matches the session schema initialized by this repository.
      const valueRows = connection
        .prepare(
          "SELECT namespace, key, seq, payload FROM halo_session_values WHERE session_id = ? ORDER BY seq",
        )
        .all(source.id) as {
        namespace: string;
        key: string;
        seq: number;
        payload: string;
      }[];
      const snapshot = createForkSnapshot(
        {
          entries: entryRows.map((row) =>
            decodeSessionJson<Entry>(row.payload),
          ),
          scalarValues: valueRows.map((row): StoredValue<unknown> => ({
            address: value(row.namespace, row.key),
            seq: row.seq,
            value: decodeSessionJson<unknown>(row.payload),
          })),
          entriesComplete: true,
        },
        options,
      );
      const metadata: SessionMetadata = {
        id,
        createdAt,
        storageVersion: 1,
        parentSessionId: source.id,
      };
      connection
        .prepare(
          "INSERT INTO halo_sessions (id, metadata, next_seq, stats) VALUES (?, ?, ?, ?)",
        )
        .run(
          id,
          JSON.stringify(metadata),
          snapshot.nextSeq,
          JSON.stringify(emptySessionStats()),
        );
      const writes: CommittedWrite[] = [
        ...[...snapshot.entries.values()].map((entry): CommittedWrite => ({
          kind: "entry",
          ...entry,
        })),
        ...snapshot.scalarValues.map((stored): CommittedWrite => ({
          kind: "value",
          op: "set",
          namespace: stored.address.namespace,
          key: stored.address.key,
          seq: stored.seq,
          value: stored.value,
        })),
      ];
      const stats = applySessionWrites(
        connection,
        id,
        writes,
        emptySessionStats(),
      );
      connection
        .prepare("UPDATE halo_sessions SET stats = ? WHERE id = ?")
        .run(JSON.stringify(stats), id);
      return metadata;
    });
  }

  async close() {
    this.closed = true;
    const results = await Promise.all(
      [...this.sessions].map(
        async (session) =>
          await session
            .close(BACKGROUND_CONTEXT)
            .catch(
              (cause) =>
                new SessionBackendError({ detail: "Close session", cause }),
            ),
      ),
    );
    return results.find((result) => result instanceof Error);
  }

  private async openSession(
    id: string,
    read: (connection: Database) => SessionMetadata,
  ) {
    this.reserve(id);
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => this.reserved.delete(id));
    const metadata = await this.database.access((connection) =>
      connection.transaction(() => read(connection))(),
    );
    if (metadata instanceof Error) throw metadata;
    const session = new StorageBackedSession(
      metadata,
      new TursoStorage(this.database, id),
      {
        onClose: () => {
          this.reserved.delete(id);
          this.sessions.delete(session);
        },
      },
    );
    this.sessions.add(session);
    cleanup.move();
    return session;
  }

  private reserve(id: string) {
    this.assertOpen();
    if (this.reserved.has(id))
      throw new SessionBackendError({
        detail: `Session is already open: ${id}`,
      });
    this.reserved.add(id);
  }

  private assertOpen() {
    if (this.closed)
      throw new SessionBackendError({ detail: "Repository is closed" });
  }
}
