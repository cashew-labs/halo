import { randomInt } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import {
  memoryEntryMaxChars,
  memoryScopes,
  memoryUpdateSchema,
  type MemoryChange,
  type MemoryEntry,
  type MemoryScope,
  type MemoryUsage,
} from "@get-halo/client";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import type { DatabaseService } from "../database/DatabaseService.js";

// Messages are written for the agent, which sees them as tool errors.
export class MemoryInputError extends errore.createTaggedError({
  name: "MemoryInputError",
  message: "$reason",
}) {}

export class MemoryNotFoundError extends errore.createTaggedError({
  name: "MemoryNotFoundError",
  message:
    "Memory entry '$id' does not exist. Another thread may have removed it; call tools.memory.list.",
}) {}

export class MemoryConflictError extends errore.createTaggedError({
  name: "MemoryConflictError",
  message:
    "Memory entry '$id' does not contain that text exactly once. Current text: $current",
}) {}

export class MemoryFullError extends errore.createTaggedError({
  name: "MemoryFullError",
  message:
    "$scope memory would use $used of $limit characters. Remove or merge entries in this same update. Current entries:\n$entries",
}) {}

export class MemoryStorageError extends errore.createTaggedError({
  name: "MemoryStorageError",
  message: "Memory storage failed during $operation",
}) {}

type AppliedMemoryChange = {
  type: MemoryChange["type"];
  id: string;
  text?: string;
  duplicate?: true;
};

// SAFETY: memoryScopes' own keys are exactly MemoryScope.
const scopes = Object.keys(memoryScopes) as MemoryScope[];
const idAlphabet = "abcdefghijklmnopqrstuvwxyz234567";

export class MemoryService {
  // Orders writes from every thread; Tandem owns the records and their transactions.
  private readonly actionQueue = new SerialQueue();
  private readonly db: DatabaseService;

  constructor(ctx: { db: DatabaseService }) {
    const { db } = ctx;
    this.db = db;
  }

  async list(input?: { scope?: MemoryScope }) {
    const entries = await this.db
      .query({ collection: "memories", orderBy: { createdAt: "asc" } })
      .catch((cause) => new MemoryStorageError({ operation: "list", cause }));
    if (entries instanceof Error) return entries;
    return {
      entries:
        input?.scope === undefined
          ? entries
          : entries.filter((entry) => entry.scope === input.scope),
      usage: usage(entries),
    };
  }

  // Applies every change or none. Checks run against current rows, never a
  // thread's prompt copy, so a stale edit fails instead of overwriting.
  async update(input: { changes: MemoryChange[]; threadId?: string }) {
    const update = { changes: input.changes };
    if (!Value.Check(memoryUpdateSchema, update)) {
      const first = Value.Errors(memoryUpdateSchema, update).First();
      return new MemoryInputError({
        reason:
          first === undefined
            ? "Invalid memory update"
            : `Invalid memory update at ${first.path}: ${first.message}`,
      });
    }
    return await this.actionQueue.run(async () => {
      await using tx = this.db.useTransaction();
      const stored = await tx
        .query({ collection: "memories" })
        .catch((cause) => new MemoryStorageError({ operation: "load", cause }));
      if (stored instanceof Error) return stored;
      const working = new Map(stored.map((entry) => [entry.id, entry]));
      const touched = new Set<string>();
      const applied: AppliedMemoryChange[] = [];
      for (const change of update.changes) {
        const result = applyChange({
          working,
          change,
          threadId: input.threadId,
          now: Date.now(),
        });
        if (result instanceof Error) return result;
        if (result.duplicate !== true) touched.add(result.id);
        applied.push(result);
      }

      const before = usage(stored);
      const after = usage([...working.values()]);
      for (const scope of scopes) {
        const { used, limit } = after[scope];
        // A batch that shrinks an over-full scope still succeeds, so lowered
        // limits never block cleanup.
        if (used > limit && used > before[scope].used)
          return new MemoryFullError({
            scope: memoryScopes[scope].title,
            used,
            limit,
            entries:
              formatEntries(
                stored
                  .filter((entry) => entry.scope === scope)
                  .toSorted((left, right) => left.createdAt - right.createdAt),
              ) || "(none)",
          });
      }

      const storedIds = new Set(stored.map((entry) => entry.id));
      for (const id of touched) {
        const entry = working.get(id);
        if (entry !== undefined) tx.set("memories", entry);
        else if (storedIds.has(id)) tx.remove("memories", id);
      }
      const committed = await this.db
        .commit(tx)
        .catch(
          (cause) => new MemoryStorageError({ operation: "commit", cause }),
        );
      if (committed instanceof Error) return committed;
      return { changes: applied, usage: after };
    });
  }

  // Text for a new thread's prompt; "" when memory is empty.
  async snapshot() {
    const listed = await this.list();
    if (listed instanceof Error) return listed;
    const sections = scopes.flatMap((scope) => {
      const entries = listed.entries.filter((entry) => entry.scope === scope);
      if (entries.length === 0) return [];
      const { used, limit } = listed.usage[scope];
      return [
        `${memoryScopes[scope].title} (${used.toLocaleString("en-US")}/${limit.toLocaleString("en-US")} chars)\n${formatEntries(entries)}`,
      ];
    });
    if (sections.length === 0) return "";
    return [
      `Saved memory from earlier threads, as of ${new Date().toDateString()}. Other threads may have changed it since; tools.memory.list shows current entries.`,
      ...sections,
    ].join("\n\n");
  }
}

function applyChange(ctx: {
  working: Map<string, MemoryEntry>;
  change: MemoryChange;
  threadId: string | undefined;
  now: number;
}):
  | AppliedMemoryChange
  | MemoryInputError
  | MemoryNotFoundError
  | MemoryConflictError {
  const { working, change, threadId, now } = ctx;
  if (change.type === "add") {
    const text = checkText(normalize(change.text));
    if (text instanceof Error) return text;
    const duplicate = [...working.values()].find(
      (entry) =>
        entry.scope === change.scope &&
        entry.text.toLowerCase() === text.toLowerCase(),
    );
    if (duplicate !== undefined)
      return {
        type: "add",
        id: duplicate.id,
        text: duplicate.text,
        duplicate: true,
      };
    const id = newEntryId(working);
    // Strictly increasing, so entries added in one batch keep their order.
    const createdAt = Math.max(
      now,
      ...[...working.values()].map((entry) => entry.createdAt + 1),
    );
    working.set(id, {
      id,
      scope: change.scope,
      text,
      threadId,
      createdAt,
      updatedAt: now,
    });
    return { type: "add", id, text };
  }

  const entry = working.get(change.id);
  if (entry === undefined) return new MemoryNotFoundError({ id: change.id });
  if (change.type === "remove") {
    working.delete(change.id);
    return { type: "remove", id: change.id };
  }

  const at = entry.text.indexOf(change.find);
  if (at < 0 || entry.text.includes(change.find, at + 1))
    return new MemoryConflictError({ id: entry.id, current: entry.text });
  const edited = normalize(
    entry.text.slice(0, at) +
      change.replace +
      entry.text.slice(at + change.find.length),
  );
  if (edited === "")
    return new MemoryInputError({
      reason: `That edit would leave memory entry '${entry.id}' empty; remove it instead.`,
    });
  const text = checkText(edited);
  if (text instanceof Error) return text;
  working.set(entry.id, { ...entry, text, threadId, updatedAt: now });
  return { type: "edit", id: entry.id, text };
}

// Entries render as single prompt lines, so newlines, control characters, and
// invisible formatting characters (including bidi controls) never reach the prompt.
function normalize(text: string) {
  return text
    .replace(/\p{Cc}/gu, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function checkText(text: string) {
  if (text === "")
    return new MemoryInputError({ reason: "Memory text is empty." });
  if (text.length > memoryEntryMaxChars)
    return new MemoryInputError({
      reason: `Memory entries are limited to ${memoryEntryMaxChars} characters; this one has ${text.length}.`,
    });
  if (/<\/memory/i.test(text))
    return new MemoryInputError({
      reason: "Memory text cannot contain </memory.",
    });
  return text;
}

// Random IDs keep a thread's stale prompt copy from naming an unrelated new entry.
function newEntryId(taken: ReadonlyMap<string, unknown>) {
  for (;;) {
    let id = "m";
    for (let index = 0; index < 5; index++)
      id += idAlphabet.charAt(randomInt(idAlphabet.length));
    if (!taken.has(id)) return id;
  }
}

function usage(entries: readonly MemoryEntry[]): MemoryUsage {
  // SAFETY: Built from every MemoryScope key.
  return Object.fromEntries(
    scopes.map((scope) => [
      scope,
      {
        used: entries
          .filter((entry) => entry.scope === scope)
          .reduce((total, entry) => total + entry.text.length, 0),
        limit: memoryScopes[scope].limit,
      },
    ]),
  ) as MemoryUsage;
}

function formatEntries(entries: readonly MemoryEntry[]) {
  return entries.map((entry) => `- [${entry.id}] ${entry.text}`).join("\n");
}
