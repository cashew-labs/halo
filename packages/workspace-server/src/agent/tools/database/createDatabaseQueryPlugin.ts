import { Type } from "@sinclair/typebox";
import * as errore from "errore";
import type { DatabaseClient } from "../../../storage/DatabaseClient.js";
import { defineHaloTool, type HaloToolPlugin } from "../HaloToolPlugin.js";

const maxRows = 50;
const maxOutputChars = 30_000;
const maxCellChars = 2_000;
const queryTimeoutMs = 3_000;

type DatabaseCell = string | number | bigint | Uint8Array | null;
type DisplayCell = string | number | null;

class InvalidDatabaseQueryError extends errore.createTaggedError({
  name: "InvalidDatabaseQueryError",
  message: "Only one read-only SELECT query is allowed",
}) {}

class DatabaseQueryError extends errore.createTaggedError({
  name: "DatabaseQueryError",
  message: "Database query failed",
}) {}

function displayValue(value: DatabaseCell) {
  // Dynamic SELECTs can return any SQLite scalar type.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof value === "string")
    return value.length > maxCellChars
      ? {
          value: `${value.slice(0, maxCellChars)}… [cell truncated]`,
          truncated: true,
        }
      : { value, truncated: false };
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof value === "bigint")
    return { value: value.toString(), truncated: false };
  if (value instanceof Uint8Array)
    return { value: `[blob: ${value.byteLength} bytes]`, truncated: true };
  return { value, truncated: false };
}

export function createDatabaseQueryPlugin(
  database: DatabaseClient,
): HaloToolPlugin {
  return {
    id: "database",
    name: "Workspace database",
    tools: [
      defineHaloTool({
        name: "query",
        description:
          "Run one read-only SQL SELECT query against Halo's current workspace database. Use ? placeholders and parameters for values. Returns at most 50 rows and 30,000 characters; large cells are shortened. Query sqlite_schema for table definitions. This includes saved conversations in halo_session_entries.",
        inputSchema: Type.Object({
          sql: Type.String({ minLength: 1, maxLength: 10_000 }),
          parameters: Type.Optional(
            Type.Array(
              Type.Union([Type.String(), Type.Number(), Type.Null()]),
              {
                maxItems: 100,
              },
            ),
          ),
        }),
        requiredCapabilities: ["workspace.files.read"],
        execute: async ({ sql, parameters }) => {
          const statement = sql.trim().replace(/;$/, "").trim();
          if (!/^(SELECT|WITH)\b/i.test(statement) || statement.includes(";"))
            return new InvalidDatabaseQueryError();

          const result = await database.access((connection) => {
            // DatabaseClient serializes this block with all other access to its
            // connection. Restore query_only before releasing the queue.
            using cleanup = new errore.DisposableStack();
            cleanup.defer(() => connection.exec("PRAGMA query_only=0"));
            connection.exec("PRAGMA query_only=1");
            const prepared = connection.prepare(statement);
            const rows: Record<string, DisplayCell>[] = [];
            let chars = 0;
            let truncated = false;
            // SAFETY: Turso returns named columns containing SQLite scalar values.
            for (const raw of prepared.iterate(parameters ?? [], {
              queryTimeout: queryTimeoutMs,
            }) as Iterable<Record<string, DatabaseCell>>) {
              if (rows.length === maxRows) {
                truncated = true;
                break;
              }
              const row = Object.fromEntries(
                Object.entries(raw).map(([key, value]) => {
                  const displayed = displayValue(value);
                  if (displayed.truncated) truncated = true;
                  return [key, displayed.value];
                }),
              );
              const rowChars = JSON.stringify(row).length;
              if (chars + rowChars > maxOutputChars) {
                truncated = true;
                break;
              }
              rows.push(row);
              chars += rowChars;
            }
            return { rows, truncated };
          });
          if (result instanceof Error)
            return new DatabaseQueryError({ cause: result });
          return { value: result };
        },
      }),
    ],
  };
}
