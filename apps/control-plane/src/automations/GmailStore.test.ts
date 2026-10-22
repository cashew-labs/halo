import crypto from "node:crypto";
import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { Pool } from "pg";
import * as errore from "errore";
import { Logger } from "@get-halo/logger";
import { DatabaseService } from "../DatabaseService.js";
import { AutomationStore } from "./AutomationStore.js";
import { GmailStore } from "./GmailStore.js";

const gmailTest = test.extend<{ gmail: GmailStore }>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest requires destructured fixture dependencies.
  gmail: async ({}, use) => {
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(() => {
      vi.useRealTimers();
    });
    const parent = resolve(
      import.meta.dirname,
      "../../../../tmp/gmail-reconnect",
    );
    await fs.mkdir(parent, { recursive: true });
    const directory = await fs.mkdtemp(join(parent, "store-"));
    cleanup.defer(
      async () => await fs.rm(directory, { recursive: true, force: true }),
    );
    let url = process.env.HALO_TEST_POSTGRES_URL;
    if (url !== undefined) {
      const admin = new Pool({ connectionString: url });
      cleanup.defer(async () => await admin.end());
      const schema = `gmail_test_${crypto.randomUUID().replaceAll("-", "")}`;
      await admin.query(`CREATE SCHEMA ${schema}`);
      cleanup.defer(async () => {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      });
      const isolated = new URL(url);
      isolated.searchParams.set("options", `-c search_path=${schema}`);
      url = isolated.toString();
    }
    const logger = new Logger();
    const db = await DatabaseService.start({
      logger,
      config:
        url === undefined
          ? { type: "sqlite", path: join(directory, "control-plane.db") }
          : { type: "postgres", connectionString: url },
    });
    if (db instanceof Error) throw db;
    cleanup.defer(async () => {
      const closed = await db.close();
      if (closed instanceof Error) throw closed;
    });
    const automations = new AutomationStore({ db, logger });
    const initialized = await automations.initialize();
    if (initialized instanceof Error) throw initialized;
    const gmail = new GmailStore({ automations });
    const started = await gmail.initialize();
    if (started instanceof Error) throw started;
    const workspaceId = crypto.randomUUID();
    const connectionAddress = "tools.google_gmail.user.personal";
    const registered = await automations.register({
      workspaceId,
      ownerUserId: "owner",
      snapshot: {
        generation: 1,
        automations: [
          {
            id: "inbox",
            revision: 1,
            name: "Inbox review",
            enabled: true,
            activation: {
              type: "trigger",
              trigger: {
                type: "gmail",
                event: "messageReceived",
                connectionAddress,
              },
            },
          },
        ],
      },
    });
    if (registered instanceof Error) throw registered;
    const registration = await automations.registration({
      workspaceId,
      automationId: "inbox",
    });
    if (registration instanceof Error) throw registration;
    if (registration === undefined)
      throw new Error("Missing inbox registration");
    const bound = await gmail.bind(
      registration,
      { emailAddress: `${workspaceId}@example.com`, historyId: "100" },
      connectionAddress,
    );
    if (bound instanceof Error) throw bound;
    await use(gmail);
  },
});

// Cloud Run failed this release with PostgreSQL 22003 at this timestamp.
// Set HALO_TEST_POSTGRES_URL to test that regression; default SQLite runs only check scheduling.
gmailTest(
  "releases a failed Gmail sync and retries after its millisecond deadline",
  async ({ gmail }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1792251101382);
    const mailbox = await gmail.claim();
    if (mailbox instanceof Error) throw mailbox;
    if (mailbox === undefined) throw new Error("Missing Gmail mailbox");

    expect(await gmail.release(mailbox, 60_000)).toBeUndefined();
    expect(await gmail.claim()).toBeUndefined();
    const released = await gmail.mailbox(mailbox.email);
    if (released instanceof Error) throw released;
    expect(Number(released?.next_sync_at)).toBe(1792251161382);

    vi.setSystemTime(1792251161382);
    const retry = await gmail.claim();
    if (retry instanceof Error) throw retry;
    expect(retry?.email).toBe(mailbox.email);
    if (retry === undefined) throw new Error("Missing Gmail retry");
    expect(await gmail.markDirty(mailbox.email)).toBeUndefined();
    expect(await gmail.release(retry, 60_000)).toBeUndefined();
    const dirty = await gmail.claim();
    if (dirty instanceof Error) throw dirty;
    expect(dirty?.email).toBe(mailbox.email);
  },
);
