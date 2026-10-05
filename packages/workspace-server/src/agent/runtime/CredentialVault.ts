import * as errore from "errore";

export class CredentialVaultError extends errore.createTaggedError({
  name: "CredentialVaultError",
  message: "Credential vault failed during $operation",
}) {}

export interface CredentialVault {
  get(id: string): Promise<string | undefined | CredentialVaultError>;
  set(id: string, value: string): Promise<void | CredentialVaultError>;
  delete(id: string): Promise<void | CredentialVaultError>;
}
