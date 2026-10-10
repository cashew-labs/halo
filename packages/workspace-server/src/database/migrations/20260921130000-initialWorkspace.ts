import type { Migration } from "../Migration.js";

export const initialWorkspaceMigration: Migration = {
  id: "20260921130000-initial-workspace",
  sql: `
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
    CREATE TABLE IF NOT EXISTS user_hotkeys (
      user_id TEXT PRIMARY KEY,
      hotkeys TEXT NOT NULL
    );
  `,
};
