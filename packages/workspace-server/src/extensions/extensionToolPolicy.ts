import * as errore from "errore";

export class ExtensionToolDeniedError extends errore.createTaggedError({
  name: "ExtensionToolDeniedError",
  message:
    "Extensions cannot manage connections, integrations, credentials or policies",
}) {}

const deniedPrefixes = [
  "executor.",
  "halo.",
  "connections.",
  "policies.",
  "oauth.",
];

export function authorizeExtensionTool(path: string) {
  // Executor resolves its sandbox form `tools.<path>` to the static address.
  let address = path;
  while (address.startsWith("tools.")) address = address.slice("tools.".length);
  if (deniedPrefixes.some((prefix) => address.startsWith(prefix)))
    return new ExtensionToolDeniedError();
}
