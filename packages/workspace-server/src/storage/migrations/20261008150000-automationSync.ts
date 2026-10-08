import type { Migration } from "../Migration.js";

export const automationSyncMigration: Migration = {
  id: "20261008150000-automation-sync",
  sql: `CREATE TABLE halo_automation_sync (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL);
    INSERT INTO halo_automation_sync VALUES (1, 1);`,
};
