import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import {
  hotkeyInputSchema,
  normalizeHotkey,
  InvalidHotkeyError,
  type Hotkey,
  type HotkeyInput,
} from "@get-halo/client";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import type { DatabaseService } from "../database/DatabaseService.js";

class HotkeyStorageError extends errore.createTaggedError({
  name: "HotkeyStorageError",
  message: "Hotkey storage failed during $operation",
}) {}

export class HotkeyService {
  // Serializes validation and writes; Tandem owns records and subscriptions.
  private readonly actionQueue = new SerialQueue();
  private readonly db: DatabaseService;
  private readonly userId: string;
  private readonly query;

  constructor(ctx: { db: DatabaseService; userId: string }) {
    this.db = ctx.db;
    this.userId = ctx.userId;
    this.query = {
      collection: "hotkeys" as const,
      where: { userId: ctx.userId },
      orderBy: { position: "asc" as const },
    };
  }

  async list() {
    const records = await this.db
      .query(this.query)
      .catch((cause) => new HotkeyStorageError({ operation: "list", cause }));
    if (records instanceof Error) return records;
    return records.map(toHotkey);
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
      await using tx = this.db.useTransaction();
      const hotkeys = await tx
        .query(this.query)
        .catch(
          (cause) =>
            new HotkeyStorageError({ operation: "read before save", cause }),
        );
      if (hotkeys instanceof Error) return hotkeys;
      if (
        input.id !== undefined &&
        !hotkeys.some((item) => item.id === input.id)
      )
        return new InvalidHotkeyError({
          reason: "That hotkey does not exist. List hotkeys to find its ID.",
        });
      if (
        hotkeys.some(
          (item) => item.id !== input.id && item.accelerator === accelerator,
        )
      )
        return new InvalidHotkeyError({
          reason: `${accelerator} is already assigned. Update or remove the existing hotkey first.`,
        });
      if (input.id === undefined && hotkeys.length >= 50)
        return new InvalidHotkeyError({
          reason: "Remove a hotkey before adding more than 50.",
        });
      const hotkey: Hotkey = {
        ...input,
        id: input.id ?? randomUUID(),
        label: input.label.trim(),
        accelerator,
      };
      tx.set("hotkeys", {
        ...hotkey,
        userId: this.userId,
        position: (hotkeys.at(-1)?.position ?? 0) + 1,
      });
      const saved = await this.db
        .commit(tx)
        .catch((cause) => new HotkeyStorageError({ operation: "save", cause }));
      if (saved instanceof Error) return saved;
      return hotkey;
    });
  }

  async remove(id: string) {
    return await this.actionQueue.run(async () => {
      await using tx = this.db.useTransaction();
      const hotkey = await tx
        .get("hotkeys", id)
        .catch(
          (cause) =>
            new HotkeyStorageError({ operation: "read before remove", cause }),
        );
      if (hotkey instanceof Error) return hotkey;
      if (hotkey === undefined || hotkey.userId !== this.userId)
        return new InvalidHotkeyError({ reason: "That hotkey does not exist" });
      tx.remove("hotkeys", id);
      return await this.db
        .commit(tx)
        .catch(
          (cause) => new HotkeyStorageError({ operation: "remove", cause }),
        );
    });
  }
}

function toHotkey({ id, label, accelerator, action }: Hotkey): Hotkey {
  return { id, label, accelerator, action };
}
