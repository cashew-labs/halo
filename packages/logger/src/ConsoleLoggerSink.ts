import type {
  LogLevel,
  LoggerEntry,
  LoggerSinkApi,
  LoggerValue,
} from "./Logger.js";

function selectLogger(level: LogLevel) {
  if (level === "error") return console.error;
  if (level === "warn") return console.warn;
  if (level === "info") return console.info;
  if (level === "debug") return console.debug;
  return console.log;
}

function isStringValue(args: { value: LoggerValue | undefined }) {
  return {}.toString.call(args.value) === "[object String]";
}

export class ConsoleLoggerSink implements LoggerSinkApi {
  log(entry: LoggerEntry) {
    const scopeLabel = entry.scopes.map((scope) => `[${scope.name}]`).join("");
    const eventField = entry.data.event;
    const event = (() => {
      if (!isStringValue({ value: eventField })) return "";
      // SAFETY: [object String] is a string primitive or String object.
      return eventField as string;
    })();
    const data: { [key: string]: LoggerValue } = {};
    for (const scope of entry.scopes) {
      Object.assign(data, scope.data);
    }
    for (const [key, value] of Object.entries(entry.data)) {
      if (key === "event") continue;
      data[key] = value;
    }

    const prefix = [
      entry.timestamp,
      entry.level.toUpperCase(),
      scopeLabel,
      event,
    ]
      .filter((part) => part.length > 0)
      .join(" ");

    selectLogger(entry.level)(prefix, data);
  }
}
