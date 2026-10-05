import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import type { FilesystemService } from "../filesystem/FilesystemService.js";

class ExtensionManifestError extends errore.createTaggedError({
  name: "ExtensionManifestError",
  message: "Extension '$id': $detail",
}) {}

const manifestSchema = Type.Object({
  name: Type.String(),
  halo: Type.Optional(
    Type.Object({
      displayName: Type.Optional(Type.String({ minLength: 1 })),
      icon: Type.Optional(Type.String({ minLength: 1 })),
    }),
  ),
});

export async function readExtensionManifest(args: {
  filesystem: FilesystemService;
  workspaceRoot: string;
  id: string;
}) {
  const source = await args.filesystem.readFile(
    join(args.workspaceRoot, ".halo", "extensions", args.id, "package.json"),
    "utf8",
  );
  if (source instanceof Error) return source;
  const manifest: unknown = errore.try({
    try: () => JSON.parse(source),
    catch: (cause) =>
      new ExtensionManifestError({
        id: args.id,
        detail: "invalid package.json",
        cause,
      }),
  });
  if (manifest instanceof Error) return manifest;
  if (!Value.Check(manifestSchema, manifest))
    return new ExtensionManifestError({
      id: args.id,
      detail: "invalid extension metadata",
    });
  return manifest;
}
