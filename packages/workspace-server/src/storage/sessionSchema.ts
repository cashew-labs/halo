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
  // SAFETY: The projection matches halo_sessions, which workspace migrations initialize before repositories open.
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
