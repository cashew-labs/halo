import {
  type CredentialProvider,
  Effect,
  ProviderKey,
  StorageError,
} from "@executor-js/sdk/core";
import type { CredentialVault } from "./CredentialVault.js";

export function createExecutorCredentialProvider(
  vault: CredentialVault,
): CredentialProvider {
  return {
    key: ProviderKey.make("halo"),
    writable: true,
    get: (id) =>
      Effect.promise(async () => await vault.get(id)).pipe(
        Effect.flatMap((value) => {
          if (value instanceof Error) {
            return Effect.fail(
              new StorageError({
                message: "Halo credential read failed",
                cause: value,
              }),
            );
          }
          // Executor's provider contract uses null for a missing credential.
          // oxlint-disable-next-line unicorn/no-null
          return Effect.succeed(value === undefined ? null : value);
        }),
      ),
    set: (id, value) =>
      Effect.promise(async () => await vault.set(id, value)).pipe(
        Effect.flatMap((result) => {
          if (result instanceof Error) {
            return Effect.fail(
              new StorageError({
                message: "Halo credential write failed",
                cause: result,
              }),
            );
          }
          return Effect.succeed(undefined);
        }),
      ),
    delete: (id) =>
      Effect.promise(async () => await vault.delete(id)).pipe(
        Effect.flatMap((result) => {
          if (result instanceof Error) {
            return Effect.fail(
              new StorageError({
                message: "Halo credential delete failed",
                cause: result,
              }),
            );
          }
          return Effect.succeed(undefined);
        }),
      ),
  };
}
