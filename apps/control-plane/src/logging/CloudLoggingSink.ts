import type {
  LoggerEntry,
  LoggerSinkApi,
  LoggerValue,
  LogLevel,
} from "@get-halo/logger";

const severity = {
  debug: "DEBUG",
  info: "INFO",
  log: "INFO",
  warn: "WARNING",
  error: "ERROR",
} satisfies Record<LogLevel, string>;

function serialize(
  value: LoggerValue,
  ancestors = new WeakSet<object>(),
): LoggerValue {
  // Do not call tagged errors' toJSON(): causes and custom fields can hold secrets.
  if (value instanceof Error)
    return {
      name: value.name,
      message: value.message,
      // errore 0.14 appends raw cause stacks with this delimiter, even without calling toJSON.
      stack: value.stack?.split("\nCaused by: ")[0] ?? "",
    };
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Serialize the shared LoggerValue union at the JSON output boundary.
  if (typeof value === "bigint") return String(value);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Only object members of LoggerValue need recursive serialization.
  if (typeof value !== "object") return value;
  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);
  const serialized = Array.isArray(value)
    ? value.map((item: LoggerValue) => serialize(item, ancestors))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          serialize(item, ancestors),
        ]),
      );
  ancestors.delete(value);
  return serialized;
}

/** Cloud Run ingests each stdout JSON line as a Google Cloud Logging entry. */
export class CloudLoggingSink implements LoggerSinkApi {
  log(entry: LoggerEntry) {
    process.stdout.write(
      `${JSON.stringify({
        timestamp: entry.timestamp,
        severity: severity[entry.level],
        message:
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- LoggerData allows any LoggerValue; Cloud Logging's message must be a string.
          typeof entry.data.event === "string" ? entry.data.event : entry.level,
        level: entry.level,
        scopes: serialize(entry.scopes),
        data: serialize(entry.data),
      })}\n`,
    );
  }
}
