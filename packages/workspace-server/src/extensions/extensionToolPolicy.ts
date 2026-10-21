import * as errore from "errore";

export class ExtensionToolDeniedError extends errore.createTaggedError({
  name: "ExtensionToolDeniedError",
  message:
    "Extensions cannot manage connections, integrations, credentials or policies, or use the person's computers",
}) {}

const deniedPrefixes = [
  "executor.",
  "halo.",
  "connections.",
  "policies.",
  "oauth.",
  // The person's own computers are a separate trust boundary from extensions.
  "devices.",
];

export function authorizeExtensionTool(path: string) {
  // Executor resolves its sandbox form `tools.<path>` to the static address.
  let address = path;
  while (address.startsWith("tools.")) address = address.slice("tools.".length);
  if (deniedPrefixes.some((prefix) => address.startsWith(prefix)))
    return new ExtensionToolDeniedError();
}
