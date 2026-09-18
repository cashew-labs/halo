import { appendFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import type { LoggerEntry, LoggerSinkApi, LoggerValue } from "./Logger.js";

export type JsonLogValue =
  | string
  | number
  | boolean
  | readonly JsonLogValue[]
  | { readonly [key: string]: JsonLogValue };

function serializeLoggerValue(
  args: { value: LoggerValue },
  seen = new WeakSet<object>(),
): JsonLogValue {
  const value = args.value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ?? "",
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeLoggerValue({ value: item }, seen));
  }

  const tag = {}.toString.call(value);
  if (tag === "[object BigInt]") {
    return String(value);
  }

  if (tag === "[object Object]") {
    // SAFETY: remaining object LoggerValue is a string-keyed bag of LoggerValue.
    const record = value as { readonly [key: string]: LoggerValue };
    if (seen.has(record)) {
      return "[Circular]";
    }
    seen.add(record);
    return Object.fromEntries(
      Object.entries(record).map(([key, entryValue]) => [
        key,
        serializeLoggerValue({ value: entryValue }, seen),
      ]),
    );
  }

  // SAFETY: remaining LoggerValue after Error, array, bigint, and object is a JSON primitive.
  return value as string | number | boolean;
}

function serializeEntries(entries: readonly LoggerEntry[]) {
  return entries
    .map(
      (entry) => `${JSON.stringify(serializeLoggerValue({ value: entry }))}\n`,
    )
    .join("");
}

export class JsonlLoggerSink implements LoggerSinkApi {
  // Entries waiting for the next batched write.
  private pending: LoggerEntry[] = [];
  // Serializes writes so overlapping flush/log calls append in order.
  private writing: Promise<void> = Promise.resolve();

  private readonly filePath: string;

  constructor({ filePath }: { filePath: string }) {
    this.filePath = filePath;
  }

  log(entry: LoggerEntry) {
    this.pending.push(entry);
    this.writing = this.writing.then(
      async () => await this.writePending(),
      async () => await this.writePending(),
    );
  }

  async flush() {
    this.writing = this.writing.then(
      async () => await this.writePending(),
      async () => await this.writePending(),
    );
    await this.writing;
  }

  destroy() {
    const entries = this.takePending();
    if (entries.length === 0) return;
    appendFileSync(this.filePath, serializeEntries(entries));
  }

  private takePending() {
    const entries = this.pending;
    this.pending = [];
    return entries;
  }

  private async writePending() {
    while (this.pending.length > 0) {
      const entries = this.takePending();
      await appendFile(this.filePath, serializeEntries(entries));
    }
  }
}
