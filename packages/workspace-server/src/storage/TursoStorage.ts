// oxlint-disable unicorn/no-null -- SQL bindings and Pi parent IDs use null.
import {
  prepareStorageCommit,
  validateCommittedWrites,
  resolveListReadOptions,
  value,
  type Storage,
  type Entry,
  type EntryStructure,
  type EntryScan,
  type StorageBranchScan,
  type UsageScan,
  type UsageRow,
  type Write,
  type Value,
  type ValueList,
  type ListReadOptions,
  type StoredValue,
  type CommittedWrite,
  type SessionStats,
} from "@earendil-works/pi-agent-core/harness/session";
import type { Database } from "@tursodatabase/database/compat";
import type { DatabaseClient } from "./DatabaseClient.js";
import {
  decodeSessionJson,
  readSessionRow,
  SessionBackendError,
} from "./sessionSchema.js";

type PayloadRow = { payload: string };
type ValueRow = PayloadRow & { namespace: string; key: string; seq: number };
type StructureRow = {
  id: string;
  parent_id: string | null;
  seq: number;
  timestamp: number;
  type: EntryStructure["type"];
  custom_type: string | null;
};

export class TursoStorage implements Storage {
  private closed = false;

  constructor(
    private readonly database: DatabaseClient,
    private readonly sessionId: string,
  ) {}

  async commit(writes: Write[]) {
    return await this.access((connection) =>
      connection.transaction(() => {
        const current = readSessionRow(connection, this.sessionId);
        const prepared = prepareStorageCommit(
          writes,
          current.nextSeq,
          Date.now(),
        );
        validateCommittedWrites(prepared.writes, current.nextSeq, {
          hasEntryId: (id) =>
            connection
              .prepare(
                "SELECT 1 FROM halo_session_entries WHERE session_id = ? AND id = ?",
              )
              .get(this.sessionId, id) !== undefined,
          hasEntryOrUsageId: (id) =>
            connection
              .prepare(`SELECT 1 FROM halo_session_entries WHERE session_id = ? AND id = ?
          UNION ALL SELECT 1 FROM halo_session_usage WHERE session_id = ? AND id = ?`)
              .get(this.sessionId, id, this.sessionId, id) !== undefined,
        });
        const stats = applySessionWrites(
          connection,
          this.sessionId,
          prepared.writes,
          current.stats,
        );
        connection
          .prepare(
            "UPDATE halo_sessions SET next_seq = ?, stats = ? WHERE id = ?",
          )
          .run(
            current.nextSeq + writes.length,
            JSON.stringify(stats),
            this.sessionId,
          );
        return { ...prepared.result, stats };
      })(),
    );
  }

  async getEntries(ids: string[]) {
    return await this.access((connection) => {
      const entries = new Map<string, Entry>();
      const statement = connection.prepare(
        "SELECT payload FROM halo_session_entries WHERE session_id = ? AND id = ?",
      );
      for (const id of ids) {
        // SAFETY: This SQL projection selects the declared row fields from Halo-owned session tables.
        const row = statement.get(this.sessionId, id) as PayloadRow | undefined;
        if (row !== undefined)
          entries.set(id, decodeSessionJson<Entry>(row.payload));
      }
      return entries;
    });
  }

  async getValue<T>(address: Value<T>) {
    return await this.access((connection) => {
      // SAFETY: This SQL projection selects the declared row fields from Halo-owned session tables.
      const row = connection
        .prepare(
          "SELECT seq, payload FROM halo_session_values WHERE session_id = ? AND namespace = ? AND key = ?",
        )
        .get(this.sessionId, address.namespace, address.key) as
        | ValueRow
        | undefined;
      if (row === undefined) return undefined;
      return {
        address,
        seq: row.seq,
        value: decodeSessionJson<T>(row.payload),
      };
    });
  }

  async scanValues<T>(prefix: Value<T>) {
    return await this.access((connection) => {
      // SAFETY: This SQL projection selects the declared row fields from Halo-owned session tables.
      const rows = connection
        .prepare(`SELECT namespace, key, seq, payload FROM halo_session_values
        WHERE session_id = ? AND namespace = ? AND substr(key, 1, length(?)) = ? ORDER BY key ASC`)
        .all(
          this.sessionId,
          prefix.namespace,
          prefix.key,
          prefix.key,
        ) as ValueRow[];
      return rows.map((row): StoredValue<T> => ({
        address: value<T>(row.namespace, row.key),
        seq: row.seq,
        value: decodeSessionJson<T>(row.payload),
      }));
    });
  }

  async readList<T>(
    address: ValueList<T>,
    options: ListReadOptions | undefined,
  ) {
    return await this.access((connection) => {
      const resolved = resolveListReadOptions(options);
      const direction = resolved.order === "asc" ? "ASC" : "DESC";
      const comparison = resolved.order === "asc" ? ">" : "<";
      const cursor = resolved.cursor === undefined ? null : resolved.cursor.seq;
      // SAFETY: This SQL projection selects the declared row fields from Halo-owned session tables.
      const rows = connection
        .prepare(`SELECT seq, payload FROM halo_session_lists
        WHERE session_id = ? AND namespace = ? AND key = ? AND (? IS NULL OR seq ${comparison} ?)
        ORDER BY seq ${direction} LIMIT ?`)
        .all(
          this.sessionId,
          address.namespace,
          address.key,
          cursor,
          cursor,
          resolved.limit,
        ) as ValueRow[];
      return rows.map((row) => ({
        seq: row.seq,
        value: decodeSessionJson<T>(row.payload),
      }));
    });
  }

  async scanEntries(query: EntryScan) {
    return await this.access((connection) => {
      const direction = query.order === "desc" ? "DESC" : "ASC";
      const type = query.type === undefined ? null : query.type;
      const customType =
        query.customType === undefined ? null : query.customType;
      const from = query.fromSeq === undefined ? null : query.fromSeq;
      const to = query.toSeq === undefined ? null : query.toSeq;
      // SAFETY: This SQL projection selects the declared row fields from Halo-owned session tables.
      const rows = connection
        .prepare(`SELECT payload FROM halo_session_entries WHERE session_id = ?
        AND (? IS NULL OR type = ?) AND (? IS NULL OR custom_type = ?)
        AND (? IS NULL OR seq >= ?) AND (? IS NULL OR seq <= ?)
        ORDER BY seq ${direction} LIMIT ?`)
        .all(
          this.sessionId,
          type,
          type,
          customType,
          customType,
          from,
          from,
          to,
          to,
          query.limit === undefined ? -1 : Math.max(0, query.limit),
        ) as PayloadRow[];
      return rows.map((row) => decodeSessionJson<Entry>(row.payload));
    });
  }

  async scanBranch(query: StorageBranchScan) {
    return await this.access((connection) => {
      const rows = this.branchRows(connection, query);
      const statement = connection.prepare(
        "SELECT payload FROM halo_session_entries WHERE session_id = ? AND id = ?",
      );
      return rows.map((row) => {
        // SAFETY: This SQL projection selects the declared row fields from Halo-owned session tables.
        const stored = statement.get(this.sessionId, row.id) as PayloadRow;
        return decodeSessionJson<Entry>(stored.payload);
      });
    });
  }

  async scanBranchStructure(query: StorageBranchScan) {
    return await this.access((connection) =>
      this.branchRows(connection, query).map((row): EntryStructure => {
        const entry: EntryStructure = {
          id: row.id,
          parentId: row.parent_id,
          seq: row.seq,
          timestamp: row.timestamp,
          type: row.type,
        };
        if (row.custom_type !== null) entry.customType = row.custom_type;
        return entry;
      }),
    );
  }

  async scanUsage(query: UsageScan) {
    return await this.access((connection) => {
      const direction = query.order === "desc" ? "DESC" : "ASC";
      const from = query.fromSeq === undefined ? null : query.fromSeq;
      const to = query.toSeq === undefined ? null : query.toSeq;
      // SAFETY: This SQL projection selects the declared row fields from Halo-owned session tables.
      const rows = connection
        .prepare(`SELECT payload FROM halo_session_usage WHERE session_id = ?
        AND (? IS NULL OR seq >= ?) AND (? IS NULL OR seq <= ?) ORDER BY seq ${direction} LIMIT ?`)
        .all(
          this.sessionId,
          from,
          from,
          to,
          to,
          query.limit === undefined ? -1 : Math.max(0, query.limit),
        ) as PayloadRow[];
      return rows.map((row) => decodeSessionJson<UsageRow>(row.payload));
    });
  }

  async getStats() {
    return await this.access(
      (connection) => readSessionRow(connection, this.sessionId).stats,
    );
  }

  async close() {
    this.closed = true;
    const drained = await this.database.access(() => undefined);
    if (drained instanceof Error) throw drained;
  }

  private async access<T>(operation: (connection: Database) => T): Promise<T> {
    if (this.closed)
      throw new SessionBackendError({ detail: "Storage is closed" });
    const result = await this.database.access(operation);
    // Pi's Storage contract uses rejected promises, unlike Halo's service interfaces.
    if (result instanceof Error) throw result;
    return result;
  }

  private branchRows(connection: Database, query: StorageBranchScan) {
    // Turso 0.7.2 does not support recursive CTEs; follow the indexed parent links directly.
    const statement =
      connection.prepare(`SELECT id, parent_id, seq, timestamp, type, custom_type
      FROM halo_session_entries WHERE session_id = ? AND id = ?`);
    const rows: StructureRow[] = [];
    let id: string | null = query.start;
    while (id !== null) {
      // SAFETY: This SQL projection selects the declared row fields from Halo-owned session tables.
      const row = statement.get(this.sessionId, id) as StructureRow | undefined;
      if (row === undefined)
        throw new SessionBackendError({ detail: `Unknown branch entry ${id}` });
      rows.push(row);
      id = row.parent_id;
    }
    if (query.order === "oldestFirst") rows.reverse();
    const stop = rows.findIndex(
      (row) => row.id === query.stopAtId || row.type === query.stopAtType,
    );
    const bounded = stop === -1 ? rows : rows.slice(0, stop + 1);
    const filtered = bounded.filter(
      (row) =>
        (query.type === undefined || row.type === query.type) &&
        (query.customType === undefined ||
          row.custom_type === query.customType) &&
        (query.cursor === undefined ||
          (query.order === "oldestFirst"
            ? row.seq > query.cursor.seq
            : row.seq < query.cursor.seq)),
    );
    return query.limit === undefined
      ? filtered
      : filtered.slice(0, Math.max(0, query.limit));
  }
}

export function applySessionWrites(
  connection: Database,
  sessionId: string,
  writes: readonly CommittedWrite[],
  stats: SessionStats,
) {
  for (const write of writes) {
    if (write.kind === "entry") {
      const { kind: _kind, ...entry } = write;
      connection
        .prepare(`INSERT INTO halo_session_entries (session_id, id, parent_id, seq, timestamp, type, custom_type, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          sessionId,
          entry.id,
          entry.parentId,
          entry.seq,
          entry.timestamp,
          entry.type,
          entry.customType === undefined ? null : entry.customType,
          JSON.stringify(entry),
        );
      if (entry.type === "message") stats.messageCount++;
    }
    if (write.kind === "usage") {
      const { kind: _kind, ...row } = write;
      connection
        .prepare(
          "INSERT INTO halo_session_usage (session_id, id, seq, payload) VALUES (?, ?, ?, ?)",
        )
        .run(sessionId, row.id, row.seq, JSON.stringify(row));
      for (const key of [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "totalTokens",
      ] as const)
        stats.usage[key] += row.usage[key];
      for (const key of [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "total",
      ] as const)
        stats.usage.cost[key] += row.usage.cost[key];
      for (const key of ["cacheWrite1h", "reasoning"] as const) {
        if (row.usage[key] !== undefined)
          stats.usage[key] =
            (stats.usage[key] === undefined ? 0 : stats.usage[key]) +
            row.usage[key];
      }
    }
    if (write.kind === "value" || write.kind === "list") {
      const table =
        write.kind === "value" ? "halo_session_values" : "halo_session_lists";
      if (write.op === "delete") {
        connection
          .prepare(
            `DELETE FROM ${table} WHERE session_id = ? AND namespace = ? AND key = ?`,
          )
          .run(sessionId, write.namespace, write.key);
      } else {
        const conflict =
          write.kind === "value"
            ? "ON CONFLICT(session_id, namespace, key) DO UPDATE SET seq = excluded.seq, payload = excluded.payload"
            : "";
        connection
          .prepare(
            `INSERT INTO ${table} (session_id, namespace, key, seq, payload) VALUES (?, ?, ?, ?, ?) ${conflict}`,
          )
          .run(
            sessionId,
            write.namespace,
            write.key,
            write.seq,
            JSON.stringify(write.value),
          );
      }
    }
  }
  return stats;
}
