import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProviderItemId } from "@executor-js/sdk/core";
import { Effect, Exit } from "effect";
import * as errore from "errore";
import { expect, test } from "vitest";
import { DatabaseService } from "../DatabaseService.js";
import {
  CredentialService,
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

const itemId = ProviderItemId.make;

credentialTest(
  "persists encrypted credentials across database reopen",
  async ({ openCredentials, databasePath }) => {
    const encryptionKey = randomBytes(32);
    const first = await openCredentials(encryptionKey);
    await Effect.runPromise(
      first.credentials.forUser("user-a").set!(
        itemId("github"),
        "secret-token-value",
      ),
    );
    const closed = await first.db.close();
    if (closed instanceof Error) throw closed;

    const raw = await fs.readFile(databasePath);
    expect(raw.includes("secret-token-value")).toBe(false);

    const second = await openCredentials(encryptionKey);
    const provider = second.credentials.forUser("user-a");
    expect(await Effect.runPromise(provider.get(itemId("github")))).toBe(
      "secret-token-value",
    );
    expect(await Effect.runPromise(provider.list!())).toEqual([
      { id: "github", name: "github" },
    ]);

    await Effect.runPromise(provider.delete!(itemId("github")));
    expect(await Effect.runPromise(provider.has!(itemId("github")))).toBe(
      false,
    );
  },
);

credentialTest(
  "keeps each user's credentials separate",
  async ({ openCredentials }) => {
    const { credentials } = await openCredentials(randomBytes(32));
    const alice = credentials.forUser("alice");
    const bob = credentials.forUser("bob");

    await Effect.runPromise(alice.set!(itemId("github"), "alice-token"));
    expect(await Effect.runPromise(bob.get(itemId("github")))).toBeNull();
    expect(await Effect.runPromise(bob.list!())).toEqual([]);

    await Effect.runPromise(bob.set!(itemId("github"), "bob-token"));
    await Effect.runPromise(bob.delete!(itemId("github")));
    expect(await Effect.runPromise(alice.get(itemId("github")))).toBe(
      "alice-token",
    );
  },
);

credentialTest(
  "rejects a wrong key or a row moved to another user",
  async ({ openCredentials }) => {
    const encryptionKey = randomBytes(32);
    const { db, credentials } = await openCredentials(encryptionKey);
    await Effect.runPromise(
      credentials.forUser("alice").set!(itemId("github"), "alice-token"),
    );

    const wrongKey = await openCredentials(randomBytes(32));
    const wrongKeyRead = await Effect.runPromiseExit(
      wrongKey.credentials.forUser("alice").get(itemId("github")),
    );
    expect(Exit.isFailure(wrongKeyRead)).toBe(true);
    expect(JSON.stringify(wrongKeyRead)).toContain("StorageError");

    const client = db.client;
    if (!(client instanceof DatabaseSync)) throw new Error("expected SQLite");
    client.exec(
      "UPDATE credential SET user_id = 'mallory' WHERE user_id = 'alice'",
    );
    const movedRead = await Effect.runPromiseExit(
      credentials.forUser("mallory").get(itemId("github")),
    );
    expect(Exit.isFailure(movedRead)).toBe(true);
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
