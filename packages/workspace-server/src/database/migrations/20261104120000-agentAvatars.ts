import type { Migration } from "../Migration.js";

export const agentAvatarsMigration: Migration = {
  id: "20261104120000-agent-avatars",
  sql: `ALTER TABLE halo_agents ADD COLUMN avatar TEXT;`,
};
