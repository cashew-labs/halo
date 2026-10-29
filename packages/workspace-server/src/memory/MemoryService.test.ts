import fs from "node:fs/promises";
import path from "node:path";
import { expect, test as baseTest } from "vitest";
import type { MemoryScope } from "@get-halo/client";
import { DatabaseService } from "../database/DatabaseService.js";
import { FilesystemService } from "../filesystem/FilesystemService.js";
import {
  MemoryConflictError,
  MemoryFullError,
  MemoryService,
} from "./MemoryService.js";

const memoryTest = baseTest.extend<{ memory: MemoryService }>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest fixture callbacks require destructured parameters.
  memory: async ({}, use) => {
    const parent = path.resolve(import.meta.dirname, "../../../../tmp/memory");
    await fs.mkdir(parent, { recursive: true });
    const directory = await fs.mkdtemp(path.join(parent, "service-"));
    const filesystem = new FilesystemService();
    const db = await DatabaseService.open({ directory, filesystem });
    if (db instanceof Error) throw db;
    await use(new MemoryService({ db }));
    const databaseClosed = await db.close();
    const filesystemClosed = await filesystem.close();
    await fs.rm(directory, { recursive: true, force: true });
    if (databaseClosed instanceof Error) throw databaseClosed;
    if (filesystemClosed instanceof Error) throw filesystemClosed;
  },
});

async function add(memory: MemoryService, scope: MemoryScope, text: string) {
  const added = await memory.update({
    changes: [{ type: "add", scope, text }],
  });
  if (added instanceof Error) throw added;
  return added.changes[0]?.id ?? "";
}

async function texts(memory: MemoryService) {
  const listed = await memory.list();
  if (listed instanceof Error) throw listed;
  return listed.entries.map((entry) => entry.text);
}

memoryTest(
  "lets only one of two concurrent edits to the same text win",
  async ({ memory }) => {
    const id = await add(memory, "workspace", "Installs use pnpm 9.");
    const results = await Promise.all([
      memory.update({
        changes: [{ type: "edit", id, find: "pnpm 9", replace: "pnpm 10" }],
        threadId: "thread-a",
      }),
      memory.update({
        changes: [{ type: "edit", id, find: "pnpm 9", replace: "pnpm 11" }],
        threadId: "thread-b",
      }),
    ]);
    const failed = results.filter((result) => result instanceof Error);
    expect(failed).toHaveLength(1);
    const [winner] = await texts(memory);
    expect(winner).toMatch(/^Installs use pnpm 1[01]\.$/);
    // The loser learns the current text, so it can reread and retry.
    expect(failed[0]).toBeInstanceOf(MemoryConflictError);
    expect(failed[0]?.message).toContain(`Current text: ${winner}`);
  },
);

memoryTest(
  "applies concurrent edits to different parts of one entry",
  async ({ memory }) => {
    const id = await add(
      memory,
      "workspace",
      "Deploys from main; tests use vitest.",
    );
    const results = await Promise.all([
      memory.update({
        changes: [{ type: "edit", id, find: "main", replace: "release" }],
      }),
      memory.update({
        changes: [{ type: "edit", id, find: "vitest", replace: "playwright" }],
      }),
    ]);
    expect(results.filter((result) => result instanceof Error)).toEqual([]);
    expect(await texts(memory)).toEqual([
      "Deploys from release; tests use playwright.",
    ]);
  },
);

memoryTest(
  "rejects a batch that would overfill a scope and writes none of it",
  async ({ memory }) => {
    const ids = [
      await add(memory, "user", `A${"a".repeat(399)}`),
      await add(memory, "user", `B${"b".repeat(399)}`),
      await add(memory, "user", `C${"c".repeat(399)}`),
    ];
    const overfilled = await memory.update({
      changes: [
        { type: "add", scope: "workspace", text: "Unrelated workspace fact." },
        { type: "add", scope: "user", text: `D${"d".repeat(399)}` },
      ],
    });
    expect(overfilled).toBeInstanceOf(MemoryFullError);
    expect(overfilled instanceof Error && overfilled.message).toContain(
      "User memory would use 1600 of 1500 characters",
    );
    expect(await texts(memory)).toHaveLength(3);

    // Removing an entry in the same batch makes room.
    const consolidated = await memory.update({
      changes: [
        { type: "remove", id: ids[0] ?? "" },
        { type: "add", scope: "user", text: `D${"d".repeat(399)}` },
      ],
    });
    expect(consolidated).not.toBeInstanceOf(Error);
    expect((await texts(memory)).map((text) => text[0])).toEqual([
      "B",
      "C",
      "D",
    ]);
  },
);
