import { Logger, type LoggerEntry, type LoggerValue } from "@get-halo/logger";
import * as errore from "errore";
import { expect, test, vi } from "vitest";
import { CloudLoggingSink } from "./CloudLoggingSink.js";

test("writes Cloud Logging JSON lines with safe diagnostics and ordered scopes", () => {
  using stdout = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const root = new Logger({ sinks: [new CloudLoggingSink()] });
  const logger = root
    .scope("control-plane")
    .scope("worker", { workspaceId: "w1" });
  class LoggingFailure extends errore.createTaggedError({
    name: "LoggingFailure",
    message: "safe failure\nsecond line",
  }) {}
  const error = Object.assign(
    new LoggingFailure({
      cause: new Error("private-provider-body"),
    }),
    { token: "private-token", toJSON: () => ({ secret: "private-json" }) },
  );
  const cycle: { [key: string]: LoggerValue } = {};
  cycle.self = cycle;
  const shared = { count: 17n };
  logger.debug({ event: "debug-event" });
  logger.info({ event: "ready" });
  logger.log({ event: "progress" });
  logger.warn({ event: "retry", error, values: [shared, shared] });
  logger.error({ event: "failed", cycle });
  const lines = stdout.mock.calls.map(([line]) => String(line));
  const entries = lines.map(
    // SAFETY: Each line was emitted synchronously by CloudLoggingSink above.
    (line) =>
      JSON.parse(line) as LoggerEntry & { severity: string; message: string },
  );
  expect(entries.map((entry) => entry.severity)).toEqual([
    "DEBUG",
    "INFO",
    "INFO",
    "WARNING",
    "ERROR",
  ]);
  expect(entries[3]).toEqual({
    timestamp: expect.any(String),
    severity: "WARNING",
    level: "warn",
    message: "retry",
    scopes: [
      { name: "control-plane", data: {} },
      { name: "worker", data: { workspaceId: "w1" } },
    ],
    data: {
      event: "retry",
      error: {
        name: "LoggingFailure",
        message: "safe failure\nsecond line",
        stack: expect.stringContaining("LoggingFailure: safe failure"),
      },
      values: [{ count: "17" }, { count: "17" }],
    },
  });
  expect(entries[4]?.data).toEqual({
    event: "failed",
    cycle: { self: "[Circular]" },
  });
  expect(lines.every((line) => line.split("\n").length === 2)).toBe(true);
  expect(lines.join("")).not.toMatch(
    /private-provider-body|private-token|private-json/,
  );
  root.destroy();
});
