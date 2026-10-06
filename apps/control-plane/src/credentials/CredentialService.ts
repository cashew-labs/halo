import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  ProviderItemId,
  ProviderKey,
  StorageError,
  type CredentialProvider,
  type ProviderEntry,
} from "@executor-js/sdk/core";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Effect } from "effect";
import * as errore from "errore";
import type { DatabaseService } from "../DatabaseService.js";

const credentialProviderKey = ProviderKey.make("halo");

const keyLength = 32;
const nonceLength = 12;
const authTagLength = 16;

const credentialRowSchema = Type.Object({
  nonce: Type.String(),
  ciphertext: Type.String(),
  auth_tag: Type.String(),
});
const credentialIdRowSchema = Type.Object({ credential_id: Type.String() });

class CredentialServiceError extends errore.createTaggedError({
  name: "CredentialServiceError",
  message: "Credential service failed: $detail",
}) {}

export class InvalidCredentialKeyError extends errore.createTaggedError({
  name: "InvalidCredentialKeyError",
  message: "Credential encryption key must be $expected bytes",
}) {}

export class CredentialDecryptionError extends errore.createTaggedError({
  name: "CredentialDecryptionError",
  message: "Credential $credentialId could not be decrypted",
}) {}

type CredentialServiceOptions = {
  db: DatabaseService;
  encryptionKey: Buffer;
};

type EncryptedCredential = {
  nonce: string;
  ciphertext: string;
  authTag: string;
};

/**
 * Stores user credentials encrypted with AES-256-GCM in the borrowed database.
 * The additional authenticated data binds each value to its user and credential
 * identifiers, so a row copied to another owner or identifier fails to decrypt.
 */
export class CredentialService {
  private readonly db: DatabaseService;
  private readonly encryptionKey: Buffer;

  private constructor(ctx: CredentialServiceOptions) {
    const { db, encryptionKey } = ctx;
    this.db = db;
    this.encryptionKey = encryptionKey;
  }

  static async start(options: CredentialServiceOptions) {
    if (options.encryptionKey.length !== keyLength)
      return new InvalidCredentialKeyError({ expected: String(keyLength) });

    const service = new CredentialService({
      db: options.db,
      // Copy so later caller mutation cannot change the active key.
      encryptionKey: Buffer.from(options.encryptionKey),
    });
    const migrated = await service.migrate();
    if (migrated instanceof Error) return migrated;
    return service;
  }

  forUser(userId: string): CredentialProvider {
    return {
      key: credentialProviderKey,
      writable: true,
      get: (credentialId: ProviderItemId) =>
        toEffect(
          "get credential",
          async () => await this.get(userId, credentialId),
        ),
      has: (credentialId: ProviderItemId) =>
        toEffect("check credential", async () => {
          const value = await this.get(userId, credentialId);
          if (value instanceof Error) return value;
          return value !== null;
        }),
      set: (credentialId: ProviderItemId, value: string) =>
        toEffect(
          "set credential",
          async () => await this.set(userId, credentialId, value),
        ),
      delete: (credentialId: ProviderItemId) =>
        toEffect(
          "delete credential",
          async () => await this.delete(userId, credentialId),
        ),
      list: () =>
        toEffect<ProviderEntry[]>(
          "list credentials",
          async () => await this.list(userId),
        ),
    };
  }

  private async get(userId: string, credentialId: string) {
    const row = await this.selectRow(userId, credentialId);
    if (row instanceof Error) return row;
    // oxlint-disable-next-line unicorn/no-null -- CredentialProvider.get reports absence as null.
    if (row === undefined) return null;
    return this.decrypt({ userId, credentialId, row });
  }

  private async set(userId: string, credentialId: string, value: string) {
    const row = this.encrypt({ userId, credentialId, value });
    const updatedAt = new Date().toISOString();
    const sql = `INSERT INTO credential (user_id, credential_id, nonce, ciphertext, auth_tag, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (user_id, credential_id) DO UPDATE SET
        nonce = excluded.nonce,
        ciphertext = excluded.ciphertext,
        auth_tag = excluded.auth_tag,
        updated_at = excluded.updated_at`;
    const params = [
      userId,
      credentialId,
      row.nonce,
      row.ciphertext,
      row.authTag,
      updatedAt,
    ];
    const client = this.db.client;

    if (client instanceof DatabaseSync) {
      return errore.try({
        try: () => {
          client.prepare(sql.replace(/\$\d+/gu, "?")).run(...params);
        },
        catch: (cause) =>
          new CredentialServiceError({ detail: "write SQLite row", cause }),
      });
    }

    return await client
      .query(sql, params)
      .then(() => undefined)
      .catch(
        (cause) =>
          new CredentialServiceError({ detail: "write PostgreSQL row", cause }),
      );
  }

  private async delete(userId: string, credentialId: string) {
    const sql =
      "DELETE FROM credential WHERE user_id = $1 AND credential_id = $2";
    const client = this.db.client;

    if (client instanceof DatabaseSync) {
      return errore.try({
        try: () => {
          client.prepare(sql.replace(/\$\d+/gu, "?")).run(userId, credentialId);
        },
        catch: (cause) =>
          new CredentialServiceError({ detail: "delete SQLite row", cause }),
      });
    }

    return await client
      .query(sql, [userId, credentialId])
      .then(() => undefined)
      .catch(
        (cause) =>
          new CredentialServiceError({
            detail: "delete PostgreSQL row",
            cause,
          }),
      );
  }

  private async list(userId: string) {
    const sql =
      "SELECT credential_id FROM credential WHERE user_id = $1 ORDER BY credential_id";
    const client = this.db.client;

    const rows: unknown[] | CredentialServiceError =
      client instanceof DatabaseSync
        ? errore.try({
            try: () => client.prepare(sql.replace(/\$\d+/gu, "?")).all(userId),
            catch: (cause) =>
              new CredentialServiceError({ detail: "list SQLite rows", cause }),
          })
        : await client
            .query(sql, [userId])
            .then((result) => result.rows)
            .catch(
              (cause) =>
                new CredentialServiceError({
                  detail: "list PostgreSQL rows",
                  cause,
                }),
            );
    if (rows instanceof Error) return rows;

    const entries: ProviderEntry[] = [];
    for (const row of rows) {
      if (!Value.Check(credentialIdRowSchema, row))
        return new CredentialServiceError({ detail: "read malformed row" });
      entries.push({
        id: ProviderItemId.make(row.credential_id),
        name: row.credential_id,
      });
    }
    return entries;
  }

  private async selectRow(userId: string, credentialId: string) {
    const sql = `SELECT nonce, ciphertext, auth_tag FROM credential
      WHERE user_id = $1 AND credential_id = $2`;
    const client = this.db.client;

    const row: unknown =
      client instanceof DatabaseSync
        ? errore.try({
            try: () =>
              client
                .prepare(sql.replace(/\$\d+/gu, "?"))
                .get(userId, credentialId),
            catch: (cause) =>
              new CredentialServiceError({ detail: "read SQLite row", cause }),
          })
        : await client
            .query(sql, [userId, credentialId])
            .then((result) => result.rows[0])
            .catch(
              (cause) =>
                new CredentialServiceError({
                  detail: "read PostgreSQL row",
                  cause,
                }),
            );
    if (row instanceof Error) return row;
    if (row === undefined) return undefined;

    if (!Value.Check(credentialRowSchema, row))
      return new CredentialServiceError({ detail: "read malformed row" });
    return {
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      authTag: row.auth_tag,
    };
  }

  private encrypt(ctx: {
    userId: string;
    credentialId: string;
    value: string;
  }): EncryptedCredential {
    const nonce = randomBytes(nonceLength);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, nonce, {
      authTagLength,
    });
    cipher.setAAD(additionalData(ctx.userId, ctx.credentialId));
    const ciphertext = Buffer.concat([
      cipher.update(ctx.value, "utf8"),
      cipher.final(),
    ]);
    return {
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  }

  private decrypt(ctx: {
    userId: string;
    credentialId: string;
    row: EncryptedCredential;
  }) {
    const { userId, credentialId, row } = ctx;
    return errore.try({
      try: () => {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          this.encryptionKey,
          Buffer.from(row.nonce, "base64"),
          { authTagLength },
        );
        decipher.setAAD(additionalData(userId, credentialId));
        decipher.setAuthTag(Buffer.from(row.authTag, "base64"));
        return Buffer.concat([
          decipher.update(Buffer.from(row.ciphertext, "base64")),
          decipher.final(),
        ]).toString("utf8");
      },
      catch: (cause) => new CredentialDecryptionError({ credentialId, cause }),
    });
  }

  private async migrate() {
    const client = this.db.client;

    if (client instanceof DatabaseSync) {
      return errore.try({
        try: () => client.exec(credentialTableSql("TEXT")),
        catch: (cause) =>
          new CredentialServiceError({
            detail: "migrate SQLite schema",
            cause,
          }),
      });
    }

    return await client
      .query(credentialTableSql("TIMESTAMPTZ"))
      .then(() => undefined)
      .catch(
        (cause) =>
          new CredentialServiceError({
            detail: "migrate PostgreSQL schema",
            cause,
          }),
      );
  }
}

function credentialTableSql(timestamp: "TEXT" | "TIMESTAMPTZ") {
  return `CREATE TABLE IF NOT EXISTS credential (
    user_id TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    updated_at ${timestamp} NOT NULL,
    PRIMARY KEY (user_id, credential_id)
  )`;
}

// JSON encoding keeps the identifier boundary unambiguous.
function additionalData(userId: string, credentialId: string) {
  return Buffer.from(JSON.stringify([userId, credentialId]), "utf8");
}

function toEffect<A>(
  label: string,
  run: () => Promise<A | Error>,
): Effect.Effect<A, StorageError> {
  return Effect.flatMap(Effect.promise(run), (value) =>
    value instanceof Error
      ? Effect.fail(
          new StorageError({
            message: `${label}: ${value.message}`,
            cause: value,
          }),
        )
      : Effect.succeed(value),
  );
}
