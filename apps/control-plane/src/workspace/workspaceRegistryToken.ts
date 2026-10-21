import { GoogleAuth, Impersonated } from "google-auth-library";
import * as errore from "errore";
class WorkspaceRegistryError extends errore.createTaggedError({
  name: "WorkspaceRegistryError",
  message: "Could not authorize the workspace image download.",
}) {}
/** Only the dedicated repository reader is delegated to a workspace host. */
export async function workspaceRegistryToken(serviceAccount: string) {
  const source = await new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  })
    .getClient()
    .catch((cause) => new WorkspaceRegistryError({ cause }));
  if (source instanceof Error) return source;
  const client = new Impersonated({
    sourceClient: source,
    targetPrincipal: serviceAccount,
    targetScopes: ["https://www.googleapis.com/auth/devstorage.read_only"],
    lifetime: 900,
  });
  const token = await client
    .getAccessToken()
    .catch((cause) => new WorkspaceRegistryError({ cause }));
  if (token instanceof Error) return token;
  // coverage-exempt: The Google SDK rejects missing accessToken before returning; this guard protects against SDK contract changes.
  if (token.token === undefined || token.token === null)
    return new WorkspaceRegistryError();
  return token.token;
}
