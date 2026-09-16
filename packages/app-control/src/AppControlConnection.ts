import fs from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";

const appControlConnectionSchema = Type.Object({
  version: Type.Literal(1),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  token: Type.String({ minLength: 1 }),
});

export type AppControlConnection = Static<typeof appControlConnectionSchema>;

export class AppControlConnectionError extends errore.createTaggedError({
  name: "AppControlConnectionError",
  message: "Halo app-control connection failed: $detail",
}) {}

export function appControlFilePath(appDataDir: string) {
  return path.join(appDataDir, "appControl.json");
}

export async function readAppControlConnection(filePath: string) {
  const raw = await fs.readFile(filePath, "utf8").catch(
    (cause) =>
      new AppControlConnectionError({
        detail: "read appControl.json; start Halo in Electron development mode",
        cause,
      }),
  );
  if (raw instanceof Error) return raw;
  const parsed = errore.try({
    // SAFETY: JSON.parse is untyped; the connection schema validates it below.
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) =>
      new AppControlConnectionError({ detail: "parse appControl.json", cause }),
  });
  if (parsed instanceof Error) return parsed;
  if (!Value.Check(appControlConnectionSchema, parsed))
    return new AppControlConnectionError({ detail: "invalid appControl.json" });
  return parsed;
}
