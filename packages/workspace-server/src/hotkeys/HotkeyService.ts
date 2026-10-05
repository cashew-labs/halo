import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { Type } from "@sinclair/typebox";
import * as errore from "errore";
import {
  hotkeyInputSchema,
  hotkeySchema,
  normalizeHotkey,
  InvalidHotkeyError,
  type Hotkey,
  type HotkeyInput,
} from "@get-halo/client";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import { Stream } from "@get-halo/shared/Stream";
import type { DatabaseClient } from "../storage/DatabaseClient.js";

export class HotkeyService {
  // Publishes committed snapshots; one queue orders writes and initial subscriptions.
  private hotkeys: Hotkey[];
  private readonly changes = new Stream<Hotkey[]>();
  private readonly actionQueue = new SerialQueue();
  private readonly database: DatabaseClient;
  private readonly userId: string;

  private constructor(ctx: {
    database: DatabaseClient;
    userId: string;
    hotkeys: Hotkey[];
  }) {
    this.database = ctx.database;
    this.userId = ctx.userId;
    this.hotkeys = ctx.hotkeys;
  }

  static async open(ctx: { database: DatabaseClient; userId: string }) {
    const stored = await ctx.database.access((connection) => {
      // SAFETY: user_hotkeys stores a non-null TEXT hotkeys column.
      return connection
        .prepare("SELECT hotkeys FROM user_hotkeys WHERE user_id = ?")
        .get(ctx.userId) as { hotkeys: string } | undefined;
    });
    if (stored instanceof Error) return stored;
    const hotkeys = errore.try({
      // SAFETY: Parsed JSON stays unknown until the schema check below.
      try: () =>
        stored === undefined ? [] : (JSON.parse(stored.hotkeys) as unknown),
      catch: (cause) =>
        new InvalidHotkeyError({
          reason: "Could not read saved hotkeys",
          cause,
        }),
    });
    if (hotkeys instanceof Error) return hotkeys;
    if (!Value.Check(Type.Array(hotkeySchema), hotkeys))
      return new InvalidHotkeyError({ reason: "Saved hotkeys are invalid" });
    return new HotkeyService({ ...ctx, hotkeys });
  }

  list() {
    return this.hotkeys;
  }

  async *watch(signal: AbortSignal | undefined) {
    const initial = await this.actionQueue.run(() => ({
      hotkeys: this.hotkeys,
      updates: this.changes.consume({ abortSignal: signal }),
    }));
    using updates = initial.updates;
    if (signal?.aborted) return;
    yield initial.hotkeys;
    yield* updates;
  }

  async save(input: HotkeyInput) {
    if (!Value.Check(hotkeyInputSchema, input))
      return new InvalidHotkeyError({ reason: "Invalid hotkey input" });
    const accelerator = normalizeHotkey(input.accelerator);
    if (accelerator instanceof Error) return accelerator;
    if (input.label.trim() === "")
      return new InvalidHotkeyError({ reason: "A hotkey needs a label" });
    if (input.action.type === "runAgent" && input.action.prompt.trim() === "")
      return new InvalidHotkeyError({
        reason: "An agent hotkey needs an instruction",
      });
    if (
      input.action.type === "openFile" &&
      (input.action.path.startsWith("/") ||
        input.action.path.includes("\\") ||
        input.action.path
          .split("/")
          .some((part) => part === ".." || part === "" || part === "."))
    ) {
      return new InvalidHotkeyError({
        reason:
          "Use a workspace-relative file path without parent directory segments",
      });
    }
    return await this.actionQueue.run(async () => {
      if (
        input.id !== undefined &&
        !this.hotkeys.some((item) => item.id === input.id)
      )
        return new InvalidHotkeyError({
          reason: "That hotkey does not exist. List hotkeys to find its ID.",
        });
      if (
        this.hotkeys.some(
          (item) => item.id !== input.id && item.accelerator === accelerator,
        )
      )
        return new InvalidHotkeyError({
          reason: `${accelerator} is already assigned. Update or remove the existing hotkey first.`,
        });
      if (input.id === undefined && this.hotkeys.length >= 50)
        return new InvalidHotkeyError({
          reason: "Remove a hotkey before adding more than 50.",
        });
      const hotkey: Hotkey = {
        ...input,
        id: input.id ?? randomUUID(),
        label: input.label.trim(),
        accelerator,
      };
      const saved = await this.persist([
        ...this.hotkeys.filter((item) => item.id !== hotkey.id),
        hotkey,
      ]);
      if (saved instanceof Error) return saved;
      return hotkey;
    });
  }

  async remove(id: string) {
    return await this.actionQueue.run(async () => {
      if (!this.hotkeys.some((item) => item.id === id))
        return new InvalidHotkeyError({ reason: "That hotkey does not exist" });
      return await this.persist(this.hotkeys.filter((item) => item.id !== id));
    });
  }

  private async persist(hotkeys: Hotkey[]) {
    const saved = await this.database.access((connection) => {
      connection
        .prepare(
          "INSERT INTO user_hotkeys (user_id, hotkeys) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET hotkeys = excluded.hotkeys",
        )
        .run(this.userId, JSON.stringify(hotkeys));
    });
    if (saved instanceof Error) return saved;
    this.hotkeys = hotkeys;
    this.changes.append(hotkeys);
  }
}
