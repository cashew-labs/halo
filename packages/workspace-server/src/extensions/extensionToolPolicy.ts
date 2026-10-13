import * as errore from "errore";

export class ExtensionToolDeniedError extends errore.createTaggedError({
  name: "ExtensionToolDeniedError",
  message:
    "Extensions cannot manage connections, integrations, credentials or policies",
}) {}

export function authorizeExtensionTool(path: string) {
  if (
    path.startsWith("executor.") ||
    path.startsWith("halo.") ||
    path.startsWith("connections.") ||
    path.startsWith("policies.") ||
    path.startsWith("oauth.")
  )
    return new ExtensionToolDeniedError();
}
