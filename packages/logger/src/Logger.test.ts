import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { JsonlLoggerSink } from "./JsonlLoggerSink.js";
import { Logger, type LoggerScope } from "./Logger.js";

const loggerTest = test.extend<{ directory: string }>({
  directory: async ({ task }, use) => {
    const parent = path.resolve(import.meta.dirname, "../../../tmp/logger");
    await fs.mkdir(parent, { recursive: true });
    const directory = await fs.mkdtemp(path.join(parent, `${task.id}-`));
    await use(directory);
    await fs.rm(directory, { recursive: true, force: true });
  },
});

loggerTest(
  "writes structured entries through the JSONL sink",
  async ({ directory }) => {
    const filePath = path.join(directory, "test.jsonl");
    const sink = new JsonlLoggerSink({ filePath });
    const logger = new Logger({ sinks: [sink] })
      .scope("main")
      .scope("ui", { route: "chat" });
    const error = new Error("boom");

    logger.error({ message: "failed", error });
    await logger.flush();

    const lines = (await fs.readFile(filePath, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    // SAFETY: JsonlLoggerSink writes one JSON object per line with Error values serialized.
    const entry = parsed as {
      level: string;
      scopes: readonly LoggerScope[];
      data: {
        message: string;
        error: { name: string; message: string; stack?: string };
      };
    };
    expect(entry.level).toBe("error");
    expect(Number.isNaN(Date.parse(parsed.timestamp))).toBe(false);
    expect(entry.scopes).toEqual([
      { name: "main", data: {} },
      { name: "ui", data: { route: "chat" } },
    ]);
    expect(entry.data).toEqual({
      message: "failed",
      error: {
        name: "Error",
        message: "boom",
        stack: error.stack,
      },
    });
  },
);

loggerTest("adds another real sink", async ({ directory }) => {
  const firstPath = path.join(directory, "first.jsonl");
  const secondPath = path.join(directory, "second.jsonl");
  const logger = new Logger({
    sinks: [new JsonlLoggerSink({ filePath: firstPath })],
  })
    .scope("main")
    .addSink(new JsonlLoggerSink({ filePath: secondPath }));

  logger.log({ event: "ready" });
  await logger.flush();

  const [first, second] = await Promise.all([
    await fs.readFile(firstPath, "utf8"),
    await fs.readFile(secondPath, "utf8"),
  ]);
  expect(first).toBe(second);
  expect(JSON.parse(first)).toMatchObject({
    scopes: [{ name: "main", data: {} }],
    data: { event: "ready" },
  });
});

loggerTest("batches queued writes until flush", async ({ directory }) => {
  const filePath = path.join(directory, "batch.jsonl");
  const logger = new Logger({
    sinks: [new JsonlLoggerSink({ filePath })],
  });

  logger.info({ event: "one" });
  logger.info({ event: "two" });
  await logger.flush();

  const lines = (await fs.readFile(filePath, "utf8")).trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0]!)).toMatchObject({ data: { event: "one" } });
  expect(JSON.parse(lines[1]!)).toMatchObject({ data: { event: "two" } });
});
