import type { Database } from "@tursodatabase/database/compat";
import * as errore from "errore";
import { DatabaseError } from "./DatabaseError.js";

const executorTables = [
  "integration",
  "subject",
  "connection",
  "oauth_client",
  "oauth_session",
  "tool",
  "definition",
  "tool_policy",
  "artifact",
  "plugin_storage",
];

export function migrateExecutorTenant(input: {
  connection: Database;
  fromTenant: string;
  toTenant: string;
}) {
  return errore.try({
    try: () =>
      input.connection.transaction(() => {
        for (const table of executorTables) {
          input.connection
            .prepare(`UPDATE "${table}" SET tenant = ? WHERE tenant = ?`)
            .run(input.toTenant, input.fromTenant);
        }
      })(),
    catch: (cause) =>
      new DatabaseError({ operation: "migrate Executor tenant", cause }),
  });
}
