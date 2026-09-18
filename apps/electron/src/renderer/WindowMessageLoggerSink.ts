import type { LoggerEntry, LoggerSinkApi } from "@get-halo/logger";
import { LOG_CHANNELS } from "../shared/channels.js";

export class WindowMessageLoggerSink implements LoggerSinkApi {
  log(entry: LoggerEntry) {
    window.postMessage(
      {
        channel: LOG_CHANNELS.log,
        payload: {
          level: entry.level,
          scopes: entry.scopes,
          data: entry.data,
        },
      },
      "*",
    );
  }
}
