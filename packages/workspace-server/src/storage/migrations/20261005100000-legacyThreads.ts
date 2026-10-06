// oxlint-disable unicorn/no-null -- Legacy SQL parent pointers and branch tips use NULL.
import type { Database } from "@tursodatabase/database/compat";
import * as errore from "errore";
import { DatabaseError } from "../DatabaseError.js";
import type { Migration } from "../Migration.js";

type LegacyEntry = {
  id: string;
  parent_id: string | null;
  seq: number;
  timestamp: number;
  type: string;
  payload: string;
};
type LegacyTip = { key: string; tip: string | null };

const migrationId = "20261005100000-legacy-threads";

/** Stage legacy rows before the already-published durable migration drops them. */
export function prepareLegacyThreads(connection: Database) {
  const staged = errore.try({
    try: () => {
      const ledger = connection
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'halo_migrations'",
        )
        .get();
      if (
        ledger !== undefined &&
        connection
          .prepare("SELECT id FROM halo_migrations WHERE id = ?")
          .get(migrationId) !== undefined
      )
        return;
      return connection.transaction(() => {
        connection.exec(`
          CREATE TABLE IF NOT EXISTS halo_legacy_sessions (
            id TEXT PRIMARY KEY, metadata TEXT, next_seq INTEGER, stats TEXT,
            marked_done INTEGER, read_receipt_cursor_id TEXT
          );
          CREATE TABLE IF NOT EXISTS halo_legacy_entries (
            session_id TEXT, id TEXT, parent_id TEXT, seq INTEGER, timestamp INTEGER,
            type TEXT, payload TEXT, PRIMARY KEY (session_id, id)
          );
          CREATE TABLE IF NOT EXISTS halo_legacy_values (
            session_id TEXT, namespace TEXT, key TEXT, seq INTEGER, payload TEXT,
            PRIMARY KEY (session_id, namespace, key)
          );
          CREATE TABLE IF NOT EXISTS halo_legacy_routine_threads (id TEXT PRIMARY KEY, session_id TEXT);
          CREATE TABLE IF NOT EXISTS legacy_branches (thread_id TEXT, name TEXT, conversation_id INTEGER, tip TEXT);
          CREATE TABLE IF NOT EXISTS legacy_entry_map (thread_id TEXT, conversation_id INTEGER, id TEXT, parent_id TEXT, seq INTEGER, timestamp INTEGER, type TEXT, payload TEXT, new_id INTEGER);
          DELETE FROM legacy_branches;
          DELETE FROM legacy_entry_map;
        `);
        if (
          connection
            .prepare(
              "SELECT name FROM sqlite_master WHERE name = 'halo_sessions'",
            )
            .get() === undefined
        ) {
          return true;
        }
        connection.exec(`
          DELETE FROM halo_legacy_routine_threads;
          DELETE FROM halo_legacy_values;
          DELETE FROM halo_legacy_entries;
          DELETE FROM halo_legacy_sessions;
          INSERT INTO halo_legacy_sessions SELECT id, metadata, next_seq, stats, marked_done, read_receipt_cursor_id FROM halo_sessions;
          INSERT INTO halo_legacy_entries SELECT session_id, id, parent_id, seq, timestamp, type, payload FROM halo_session_entries;
          INSERT INTO halo_legacy_values SELECT session_id, namespace, key, seq, payload FROM halo_session_values;

        `);
        if (
          connection
            .prepare(
              "SELECT name FROM sqlite_master WHERE name = 'halo_routine_runs'",
            )
            .get() !== undefined
        )
          connection.exec(
            "INSERT OR IGNORE INTO halo_legacy_routine_threads SELECT id, session_id FROM halo_routine_runs",
          );
        return true;
      })();
    },
    catch: (cause) =>
      new DatabaseError({ operation: "stage legacy threads", cause }),
  });
  if (staged instanceof Error) return staged;
  if (staged === undefined) return;
  const rows = errore.try({
    try: () => ({
      // SAFETY: These projections match the staging tables; branch tips are JSON string IDs or null.
      sessions: connection
        .prepare("SELECT id FROM halo_legacy_sessions ORDER BY id")
        .all() as { id: string }[],
      // SAFETY: The staging projection includes the original entry columns and its session ID.
      entries: connection
        .prepare(
          "SELECT session_id,id,parent_id,seq,timestamp,type,payload FROM halo_legacy_entries ORDER BY session_id,seq",
        )
        .all() as (LegacyEntry & { session_id: string })[],
      // SAFETY: Pi branch tips are JSON string IDs or JSON null with their session ID.
      tips: connection
        .prepare(
          "SELECT session_id,key,json_extract(payload,'$') AS tip FROM halo_legacy_values WHERE namespace='pi.branch.tip' ORDER BY session_id,key",
        )
        .all() as (LegacyTip & { session_id: string })[],
    }),
    catch: (cause) =>
      new DatabaseError({ operation: "read staged legacy threads", cause }),
  });
  if (rows instanceof Error) return rows;
  const branches = stageBranches(rows);
  if (branches instanceof Error) return branches;
  return errore.try({
    try: () =>
      connection.transaction(() => {
        const insertBranch = connection.prepare(
          "INSERT INTO legacy_branches VALUES (?, ?, ?, ?)",
        );
        const insertEntry = connection.prepare(
          "INSERT INTO legacy_entry_map VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const row of branches.branches) insertBranch.run(...row);
        for (const row of branches.entries) insertEntry.run(...row);
      })(),
    catch: (cause) =>
      new DatabaseError({ operation: "write staged legacy branches", cause }),
  });
}

/** Turso has no recursive CTE support; prepare parent chains before the SQL transaction. */
function stageBranches(rows: {
  sessions: { id: string }[];
  entries: (LegacyEntry & { session_id: string })[];
  tips: (LegacyTip & { session_id: string })[];
}) {
  const branchRows: [string, string, number, string | null][] = [];
  const entryRows: [
    string,
    number,
    string,
    string | null,
    number,
    number,
    string,
    string,
    number,
  ][] = [];
  for (const { id: threadId } of rows.sessions) {
    const entries = rows.entries.filter(
      (entry) => entry.session_id === threadId,
    );
    const tips = rows.tips.filter((tip) => tip.session_id === threadId);
    const main = tips.find((tip) => tip.key === "main");
    const branches = [
      {
        key: "main",
        tip: main === undefined ? (entries.at(-1)?.id ?? null) : main.tip,
      },
      ...tips.filter((tip) => tip.key !== "main"),
    ];
    const parents = new Set(entries.map((entry) => entry.parent_id));
    // Keep abandoned branch history too, even if its named branch was deleted.
    for (const entry of entries) {
      if (
        !parents.has(entry.id) &&
        !branches.some((branch) => branch.tip === entry.id)
      )
        branches.push({ key: `history:${entry.id}`, tip: entry.id });
    }
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    let nextId = branches.length + 1;
    const copied = new Set<string>();
    for (const [index, branch] of branches.entries()) {
      const conversationId = index + 1;
      branchRows.push([threadId, branch.key, conversationId, branch.tip]);
      const history: LegacyEntry[] = [];
      const visited = new Set<string>();
      let entryId = branch.tip;
      while (entryId !== null) {
        const entry = byId.get(entryId);
        if (entry === undefined || visited.has(entryId))
          return new DatabaseError({
            operation: "stage legacy threads",
            cause: new Error(
              `Invalid legacy parent chain in thread ${threadId}`,
            ),
          });
        visited.add(entryId);
        copied.add(entryId);
        history.push(entry);
        entryId = entry.parent_id;
      }
      for (const entry of history.toReversed()) {
        entryRows.push([
          threadId,
          conversationId,
          entry.id,
          entry.parent_id,
          entry.seq,
          entry.timestamp,
          entry.type,
          entry.payload,
          nextId++,
        ]);
      }
    }
    if (copied.size !== entries.length)
      return new DatabaseError({
        operation: "stage legacy threads",
        cause: new Error(`Unreachable legacy entries in thread ${threadId}`),
      });
  }
  return { branches: branchRows, entries: entryRows };
}

export const legacyThreadsMigration: Migration = {
  id: migrationId,
  sql: `
    INSERT INTO halo_threads (id,metadata,marked_done,read_receipt_cursor_id)
      SELECT id,metadata,marked_done,NULL FROM halo_legacy_sessions;
    INSERT INTO conversations (thread_id,id,record)
      SELECT thread_id,conversation_id,json_object('id',conversation_id) FROM legacy_branches;
    INSERT INTO record_ids (thread_id,id,record_type)
      SELECT thread_id,conversation_id,'conversation' FROM legacy_branches;

    INSERT INTO entries (thread_id,id,conversation_id,head,commit_seq,record)
      SELECT thread_id,new_id,conversation_id,CASE WHEN type='compaction' THEN new_id END,1,
        json_patch(json_object('id',new_id,'conversationId',conversation_id,
          'kind',CASE WHEN type='compaction' THEN 'pi.compaction' ELSE 'halo.legacy' END,
          'data',CASE WHEN type='message' THEN json_object('message',json_extract(payload,'$.message')) ELSE json(payload) END),
          CASE
            WHEN type='compaction' THEN json_object('head',new_id,'model',json((
              SELECT json_group_array(json(message)) FROM (
                SELECT json_object('role','user','content',json_extract(payload,'$.summary'),'timestamp',timestamp) AS message,-1 AS ordinal
                UNION ALL SELECT value,key FROM json_each(json_extract(payload,'$.retainedTail')) ORDER BY ordinal
              )
            )))
            WHEN type='message' AND json_extract(payload,'$.message.role') IN ('user','assistant','toolResult')
              THEN json_object('model',json_array(json_extract(payload,'$.message')))
            WHEN type='message' AND json_extract(payload,'$.message.role')='custom'
              THEN json_object('model',json_array(json_object('role','user','content',json_extract(payload,'$.message.content'),'timestamp',timestamp)))
            WHEN type='message' AND json_extract(payload,'$.message.role')='bashExecution'
              AND coalesce(json_extract(payload,'$.message.excludeFromContext'),0)=0
              THEN json_object('model',json_array(json_object('role','user','content',
                '$ '||json_extract(payload,'$.message.command')||char(10)||json_extract(payload,'$.message.output'),'timestamp',timestamp)))
            ELSE json('{}') END)
      FROM legacy_entry_map;
    INSERT INTO record_ids (thread_id,id,record_type) SELECT thread_id,new_id,'entry' FROM legacy_entry_map;

    CREATE TEMP VIEW legacy_document_ids AS
      SELECT s.id AS thread_id,coalesce((SELECT max(new_id) FROM legacy_entry_map m WHERE m.thread_id=s.id),
        (SELECT max(conversation_id) FROM legacy_branches b WHERE b.thread_id=s.id))+1 AS document_id
      FROM halo_legacy_sessions s;
    INSERT INTO documents (thread_id,id,kind,family,key_value,scope_kind,owner_id,created_at,record)
      SELECT thread_id,document_id,'"halo.thread"',0,'""','conversation',1,1,
        json_object('id',document_id,'kind','halo.thread','scope',json_object('kind','conversation','conversationId',1),
          'history','latest','fork','initial','createdAt',1) FROM legacy_document_ids;
    INSERT INTO record_ids (thread_id,id,record_type) SELECT thread_id,document_id,'document' FROM legacy_document_ids;
    INSERT INTO document_revisions (thread_id,document_id,seq,kind,version,content)
      SELECT d.thread_id,d.document_id,1,'base',1,
        json_patch(json_object('inputs',json('{}')),coalesce((
          SELECT json_object('name',json_extract(v.payload,'$')) FROM halo_legacy_values v
            WHERE v.session_id=d.thread_id AND v.namespace='pi.session.name' AND v.key=''
        ),json('{}'))) FROM legacy_document_ids d;
    INSERT INTO durable_metadata (thread_id,next_id,next_seq)
      SELECT thread_id,cast(document_id+1 AS TEXT),2 FROM legacy_document_ids;

    UPDATE halo_threads SET read_receipt_cursor_id=cast((
      SELECT max(m.new_id) FROM legacy_entry_map m WHERE m.thread_id=halo_threads.id AND m.conversation_id=1
        AND json_extract(m.payload,'$.message.role')='assistant' AND m.seq<=(
          SELECT tip.seq FROM legacy_entry_map tip WHERE tip.thread_id=m.thread_id AND tip.conversation_id=1
            AND tip.id=coalesce((SELECT json_extract(v.payload,'$.tipId') FROM halo_legacy_values v
              JOIN halo_legacy_sessions s ON s.id=v.session_id
              WHERE v.session_id=m.thread_id AND v.namespace='pi.result' AND v.key=s.read_receipt_cursor_id),
              (SELECT read_receipt_cursor_id FROM halo_legacy_sessions s WHERE s.id=m.thread_id))
        )
    ) AS TEXT) WHERE id IN (SELECT id FROM halo_legacy_sessions);
    UPDATE halo_routine_runs SET thread_id=(SELECT session_id FROM halo_legacy_routine_threads r WHERE r.id=halo_routine_runs.id)
      WHERE EXISTS (SELECT 1 FROM halo_legacy_routine_threads r JOIN halo_threads t ON t.id=r.session_id WHERE r.id=halo_routine_runs.id);

    DROP VIEW legacy_document_ids;
    DROP TABLE legacy_entry_map;
    DROP TABLE legacy_branches;
    DROP TABLE halo_legacy_routine_threads;
    DROP TABLE halo_legacy_values;
    DROP TABLE halo_legacy_entries;
    DROP TABLE halo_legacy_sessions;
  `,
};
