import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as errore from "errore";
import { expect, test } from "vitest";
import { DatabaseService } from "../DatabaseService.js";
import {
  CredentialService,
  CredentialDecryptionError,
  InvalidCredentialKeyError,
} from "./CredentialService.js";

type OpenCredentials = (
  encryptionKey: Buffer,
) => Promise<{ db: DatabaseService; credentials: CredentialService }>;

const credentialTest = test.extend<{
  databasePath: string;
  openCredentials: OpenCredentials;
}>({
  databasePath: async ({ task }, use) => {
    const parent = resolve(
      import.meta.dirname,
      "../../../../tmp/control-plane",
    );
    await fs.mkdir(parent, { recursive: true });
    const directory = await fs.mkdtemp(join(parent, `${task.id}-`));
    await use(join(directory, "control-plane.db"));
    await fs.rm(directory, { recursive: true, force: true });
  },
  // Each call opens a new connection to the same file, so tests can reopen it.
  openCredentials: async ({ databasePath }, use) => {
    await using cleanup = new errore.AsyncDisposableStack();

    await use(async (encryptionKey) => {
      const db = await DatabaseService.start({
        type: "sqlite",
        path: databasePath,
      });
      if (db instanceof Error) throw db;
      cleanup.defer(async () => {
        if (db.client instanceof DatabaseSync && !db.client.isOpen) return;
        const closed = await db.close();
        if (closed instanceof Error) throw closed;
      });

      const credentials = await CredentialService.start({ db, encryptionKey });
      if (credentials instanceof Error) throw credentials;
      return { db, credentials };
    });
  },
});

credentialTest(
  "persists encrypted credentials across database reopen",
  async ({ openCredentials, databasePath }) => {
    const encryptionKey = randomBytes(32);
    const first = await openCredentials(encryptionKey);
    expect(
      await first.credentials.set("user-a", "github", "secret-token-value"),
    ).toBeUndefined();
    const closed = await first.db.close();
    if (closed instanceof Error) throw closed;

    const raw = await fs.readFile(databasePath);
    expect(raw.includes("secret-token-value")).toBe(false);

    const second = await openCredentials(encryptionKey);
    expect(await second.credentials.get("user-a", "github")).toBe(
      "secret-token-value",
    );
    expect(await second.credentials.list("user-a")).toEqual(["github"]);
    expect(await second.credentials.delete("user-a", "github")).toBeUndefined();
    expect(await second.credentials.get("user-a", "github")).toBeUndefined();
  },
);

credentialTest(
  "keeps each user's credentials separate",
  async ({ openCredentials }) => {
    const { credentials } = await openCredentials(randomBytes(32));
    expect(
      await credentials.set("alice", "github", "alice-token"),
    ).toBeUndefined();
    expect(await credentials.get("bob", "github")).toBeUndefined();
    expect(await credentials.list("bob")).toEqual([]);

    expect(await credentials.set("bob", "github", "bob-token")).toBeUndefined();
    expect(await credentials.delete("bob", "github")).toBeUndefined();
    expect(await credentials.get("alice", "github")).toBe("alice-token");
  },
);

credentialTest(
  "rejects a wrong key or a row moved to another user",
  async ({ openCredentials }) => {
    const encryptionKey = randomBytes(32);
    const { db, credentials } = await openCredentials(encryptionKey);
    expect(
      await credentials.set("alice", "github", "alice-token"),
    ).toBeUndefined();

    const wrongKey = await openCredentials(randomBytes(32));
    const wrongKeyRead = await wrongKey.credentials.get("alice", "github");
    expect(wrongKeyRead).toBeInstanceOf(CredentialDecryptionError);

    const client = db.client;
    if (!(client instanceof DatabaseSync)) throw new Error("expected SQLite");
    client.exec(
      "UPDATE credential SET user_id = 'mallory' WHERE user_id = 'alice'",
    );
    const movedRead = await credentials.get("mallory", "github");
    expect(movedRead).toBeInstanceOf(CredentialDecryptionError);
  },
);

credentialTest(
  "requires a 32-byte encryption key",
  async ({ databasePath }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const db = await DatabaseService.start({
      type: "sqlite",
      path: databasePath,
    });
    if (db instanceof Error) throw db;
    cleanup.defer(async () => {
      await db.close();
    });

    const started = await CredentialService.start({
      db,
      encryptionKey: randomBytes(16),
    });
    expect(started).toBeInstanceOf(InvalidCredentialKeyError);
  },
);
