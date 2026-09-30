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
import { Stream } from "@get-halo/shared/Stream";
import type { DatabaseService } from "../storage/DatabaseService.js";

class HotkeyStorageError extends errore.createTaggedError({
  name: "HotkeyStorageError",
  message: "Hotkey storage failed during $operation",
}) {}

export class HotkeyService {
  // Serializes validation and writes; Tandem owns records and subscriptions.
  private readonly actionQueue = new SerialQueue();
  private readonly tandem: DatabaseService["tandem"];
  private readonly userId: string;
  private readonly query;

  constructor(ctx: { tandem: DatabaseService["tandem"]; userId: string }) {
    this.tandem = ctx.tandem;
    this.userId = ctx.userId;
    this.query = {
      collection: "hotkeys" as const,
      where: { userId: ctx.userId },
      orderBy: { position: "asc" as const },
    };
  }

  async list() {
    const records = await this.tandem
      .query(this.query)
      .catch((cause) => new HotkeyStorageError({ operation: "list", cause }));
    if (records instanceof Error) return records;
    return records.map(toHotkey);
  }

  async *watch(signal: AbortSignal | undefined) {
    const changes = new Stream<Hotkey[] | HotkeyStorageError>();
    using updates = changes.consume({ abortSignal: signal });
    using cleanup = new errore.DisposableStack();
    if (signal?.aborted) return;
    const subscription = await this.tandem
      .subscribe(
        this.query,
        (records) => changes.append(records.map(toHotkey)),
        {
          onError: (cause) =>
            changes.append(
              new HotkeyStorageError({ operation: "watch", cause }),
            ),
        },
      )
      .catch((cause) => new HotkeyStorageError({ operation: "watch", cause }));
    if (subscription instanceof Error) {
      yield subscription;
      return;
    }
    cleanup.defer(() => subscription.destroy());
    if (signal?.aborted) return;
    yield subscription.result.map(toHotkey);
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
      const transaction = this.tandem.transact();
      await using cleanup = new errore.AsyncDisposableStack();
      cleanup.defer(async () => {
        await transaction
          .cancel()
          .catch((cause) =>
            console.warn(
              new HotkeyStorageError({ operation: "cancel", cause }),
            ),
          );
      });
      const hotkeys = await transaction
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
      transaction.set("hotkeys", {
        ...hotkey,
        userId: this.userId,
        position: (hotkeys.at(-1)?.position ?? 0) + 1,
      });
      // Commit consumes the transaction, including when it rejects.
      cleanup.move();
      const saved = await this.tandem
        .commit(transaction)
        .catch((cause) => new HotkeyStorageError({ operation: "save", cause }));
      if (saved instanceof Error) return saved;
      return hotkey;
    });
  }

  async remove(id: string) {
    return await this.actionQueue.run(async () => {
      const transaction = this.tandem.transact();
      await using cleanup = new errore.AsyncDisposableStack();
      cleanup.defer(async () => {
        await transaction
          .cancel()
          .catch((cause) =>
            console.warn(
              new HotkeyStorageError({ operation: "cancel", cause }),
            ),
          );
      });
      const hotkey = await transaction
        .get("hotkeys", id)
        .catch(
          (cause) =>
            new HotkeyStorageError({ operation: "read before remove", cause }),
        );
      if (hotkey instanceof Error) return hotkey;
      if (hotkey === undefined || hotkey.userId !== this.userId)
        return new InvalidHotkeyError({ reason: "That hotkey does not exist" });
      transaction.remove("hotkeys", id);
      cleanup.move();
      return await this.tandem
        .commit(transaction)
        .catch(
          (cause) => new HotkeyStorageError({ operation: "remove", cause }),
        );
    });
  }
}

function toHotkey({ id, label, accelerator, action }: Hotkey): Hotkey {
  return { id, label, accelerator, action };
}
