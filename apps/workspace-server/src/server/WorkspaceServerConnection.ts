import fs from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";

const connectionSchema = Type.Object({
  workspaceRoot: Type.String(),
  origin: Type.String(),
  token: Type.String(),
});

export type WorkspaceServerConnection = Static<typeof connectionSchema>;

class ConnectionFileError extends errore.createTaggedError({
  name: "ConnectionFileError",
  message: "User-server connection file: $operation",
}) {}

function connectionFile(appDataDir: string) {
  return join(appDataDir, "server.json");
}

export async function readWorkspaceServerConnection(appDataDir: string) {
  const raw = await fs
    .readFile(connectionFile(appDataDir), "utf8")
    .catch((cause: NodeJS.ErrnoException) =>
      cause.code === "ENOENT"
        ? undefined
        : new ConnectionFileError({ operation: "read", cause }),
    );
  if (raw === undefined || raw instanceof Error) return raw;
  const parsed = errore.try({
    // SAFETY: JSON.parse is untyped; connectionSchema validates the published connection.
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) => new ConnectionFileError({ operation: "parse", cause }),
  });
  if (parsed instanceof Error) return parsed;
  if (!Value.Check(connectionSchema, parsed))
    return new ConnectionFileError({ operation: "invalid connection" });
  return parsed;
}

export async function writeWorkspaceServerConnection(ctx: {
  appDataDir: string;
  connection: WorkspaceServerConnection;
}) {
  const destination = connectionFile(ctx.appDataDir);
  const written = await fs
    .writeFile(`${destination}.tmp`, JSON.stringify(ctx.connection), {
      mode: 0o600,
    })
    .catch((cause) => new ConnectionFileError({ operation: "write", cause }));
  if (written instanceof Error) return written;
  return await fs
    .rename(`${destination}.tmp`, destination)
    .catch((cause) => new ConnectionFileError({ operation: "publish", cause }));
}

export async function removeWorkspaceServerConnection(appDataDir: string) {
  return await fs
    .rm(connectionFile(appDataDir), { force: true })
    .catch((cause) => new ConnectionFileError({ operation: "remove", cause }));
}
