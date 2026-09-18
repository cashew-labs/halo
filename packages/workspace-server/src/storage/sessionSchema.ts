import type {
  SessionMetadata,
  SessionStats,
} from "@earendil-works/pi-agent-core/harness/session";
import type { Database } from "@tursodatabase/database/compat";
import * as errore from "errore";

export class SessionBackendError extends errore.createTaggedError({
  name: "SessionBackendError",
  message: "Session storage: $detail",
}) {}

export const sessionSchema = `
CREATE TABLE IF NOT EXISTS halo_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  metadata TEXT NOT NULL,
  next_seq INTEGER NOT NULL,
  stats TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS halo_session_entries (
  session_id TEXT NOT NULL REFERENCES halo_sessions(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  parent_id TEXT,
  seq INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  custom_type TEXT,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, seq)
);
CREATE TABLE IF NOT EXISTS halo_session_values (
  session_id TEXT NOT NULL REFERENCES halo_sessions(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, namespace, key)
);
CREATE TABLE IF NOT EXISTS halo_session_lists (
  session_id TEXT NOT NULL REFERENCES halo_sessions(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, namespace, key, seq)
);
CREATE TABLE IF NOT EXISTS halo_session_usage (
  session_id TEXT NOT NULL REFERENCES halo_sessions(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, seq)
);
`;

export function emptySessionStats(): SessionStats {
  return {
    messageCount: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

export function readSessionRow(connection: Database, id: string) {
  // SAFETY: The projection matches halo_sessions, whose schema is initialized by TursoSessionRepo.
  const row = connection
    .prepare("SELECT metadata, next_seq, stats FROM halo_sessions WHERE id = ?")
    .get(id) as
    | { metadata: string; next_seq: number; stats: string }
    | undefined;
  // Pi's Storage/SessionRepo interfaces require promise rejection for invalid handles.
  if (row === undefined)
    throw new SessionBackendError({ detail: `Unknown session ${id}` });
  return {
    metadata: decodeSessionJson<SessionMetadata>(row.metadata),
    nextSeq: row.next_seq,
    stats: decodeSessionJson<SessionStats>(row.stats),
  };
}

export function decodeSessionJson<T>(payload: string): T {
  // SAFETY: These payloads are written from Pi's typed values by this backend and read under the same schema version.
  return JSON.parse(payload) as T;
}
