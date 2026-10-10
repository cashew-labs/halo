import type { Migration } from "../Migration.js";
export const automationEventRetentionMigration: Migration = {
  id: "20261008160000-automation-event-retention",
  sql: "ALTER TABLE halo_automation_runs ADD COLUMN payload_hash TEXT;",
};
