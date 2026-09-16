import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { Logger } from "@get-halo/logger";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import type { TraceAgent, TraceOutcome, TraceRecord } from "@get-halo/client";
import * as errore from "errore";
import { RunTrace, TraceStorageError } from "./RunTrace.js";

export type TraceUploader = {
  upload(input: { key: string; filePath: string }): Promise<void | Error>;
};

export class TraceService {
  // Owns runs until their final records are committed locally.
  private readonly runs = new Map<string, RunTrace>();
  // Serializes uploads without holding any agent operation queue.
  private readonly actionQueue = new SerialQueue();
  // Retries durable pending uploads while the server is running.
  private timer: NodeJS.Timeout | undefined;
  // Stops new uploads and runs during shutdown.
  private closed = false;

  private readonly directory: string;
  private readonly workspaceId: string;
  private readonly appVersion: string;
  private readonly logger: Logger;
  private readonly uploader: TraceUploader | undefined;

  private constructor(ctx: {
    directory: string;
    workspaceId: string;
    appVersion: string;
    logger: Logger;
    uploader?: TraceUploader;
  }) {
    const { directory, workspaceId, appVersion, logger, uploader } = ctx;
    this.directory = directory;
    this.workspaceId = workspaceId;
    this.appVersion = appVersion;
    this.logger = logger;
    this.uploader = uploader;
  }

  static async open(ctx: {
    directory: string;
    appVersion: string;
    logger: Logger;
    uploader?: TraceUploader;
  }) {
    const created = await fs
      .mkdir(ctx.directory, { recursive: true, mode: 0o700 })
      .catch(
        (cause) =>
          new TraceStorageError({ operation: "create trace directory", cause }),
      );
    if (created instanceof Error) return created;
    const identityPath = path.join(ctx.directory, "workspaceId");
    const identity = await fs
      .readFile(identityPath, "utf8")
      .catch((cause: NodeJS.ErrnoException) =>
        cause.code === "ENOENT"
          ? undefined
          : new TraceStorageError({
              operation: "read workspace identity",
              cause,
            }),
      );
    if (identity instanceof Error) return identity;
    const workspaceId =
      identity === undefined ? crypto.randomUUID() : identity.trim();
    if (identity === undefined) {
      const saved = await fs
        .writeFile(identityPath, workspaceId, {
          mode: 0o600,
          flag: "wx",
          flush: true,
        })
        .catch(
          (cause) =>
            new TraceStorageError({
              operation: "write workspace identity",
              cause,
            }),
        );
      if (saved instanceof Error) return saved;
    }
    const service = new TraceService({ ...ctx, workspaceId });
    const recovered = await service.recover();
    if (recovered instanceof Error) return recovered;
    if (ctx.uploader !== undefined) {
      service.timer = setInterval(() => service.scheduleUpload(), 30_000);
      service.timer.unref();
      service.scheduleUpload();
    }
    return service;
  }

  async start(input: { sessionId: string; agent: TraceAgent; data?: unknown }) {
    if (this.closed)
      return new TraceStorageError({ operation: "start during shutdown" });
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.sessionId))
      return new TraceStorageError({ operation: "validate session ID" });
    const traceId = crypto.randomBytes(16).toString("hex");
    const filePath = this.activePath(input.sessionId, traceId);
    const created = await fs
      .mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
      .catch(
        (cause) =>
          new TraceStorageError({ operation: "create run directory", cause }),
      );
    if (created instanceof Error) return created;
    const run = new RunTrace({
      workspaceId: this.workspaceId,
      sessionId: input.sessionId,
      traceId,
      spanId: RunTrace.spanId(),
      filePath,
      sequence: 0,
    });
    const written = await run.record({
      type: "run.started",
      spanId: run.spanId,
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.id": input.agent.id,
        "service.version": this.appVersion,
      },
      data: { agent: input.agent, context: input.data },
    });
    if (written instanceof Error) return written;
    this.runs.set(traceId, run);
    return run;
  }

  get(traceId: string) {
    const run = this.runs.get(traceId);
    if (run === undefined)
      return new TraceStorageError({ operation: "find active run" });
    return run;
  }

  async finish(traceId: string, outcome: TraceOutcome) {
    const run = this.get(traceId);
    if (run instanceof Error) return run;
    this.runs.delete(traceId);
    const finished = await run.finish(outcome);
    if (finished instanceof Error) return finished;
    const archived = await this.archive(run.sessionId, traceId);
    if (archived instanceof Error) return archived;
    this.scheduleUpload();
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const run of this.runs.values()) {
      const finished = await this.finish(run.traceId, "interrupted");
      if (finished instanceof Error) this.report(finished);
    }
    // Pending files survive shutdown; only an already running upload needs to settle.
    await this.actionQueue.run(() => undefined);
  }

  report(error: Error) {
    this.logger.warn({ event: "trace-storage-failed", error });
  }

  private key(sessionId: string, traceId: string) {
    return `v1/workspaces/${this.workspaceId}/sessions/${sessionId}/${traceId}.jsonl.gz`;
  }

  private activePath(sessionId: string, traceId: string) {
    return path.join(this.directory, "active", sessionId, `${traceId}.jsonl`);
  }

  private async archive(sessionId: string, traceId: string) {
    const source = this.activePath(sessionId, traceId);
    const destination = path.join(
      this.directory,
      "pending",
      this.key(sessionId, traceId),
    );
    const created = await fs
      .mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      .catch(
        (cause) =>
          new TraceStorageError({
            operation: "create archive directory",
            cause,
          }),
      );
    if (created instanceof Error) return created;
    const compressed = await pipeline(
      createReadStream(source),
      createGzip(),
      createWriteStream(`${destination}.tmp`, { mode: 0o600, flush: true }),
    ).catch(
      (cause) => new TraceStorageError({ operation: "compress run", cause }),
    );
    if (compressed instanceof Error) return compressed;
    const renamed = await fs
      .rename(`${destination}.tmp`, destination)
      .catch(
        (cause) =>
          new TraceStorageError({ operation: "publish archive", cause }),
      );
    if (renamed instanceof Error) return renamed;
    return await fs
      .unlink(source)
      .catch(
        (cause) =>
          new TraceStorageError({ operation: "remove active run", cause }),
      );
  }

  private async recover() {
    const files = await traceFiles(path.join(this.directory, "active"));
    if (files instanceof Error) return files;
    for (const file of files.filter((candidate) =>
      candidate.endsWith(".jsonl"),
    )) {
      const filePath = path.join(this.directory, "active", file);
      const content = await fs
        .readFile(filePath, "utf8")
        .catch(
          (cause) =>
            new TraceStorageError({ operation: "read interrupted run", cause }),
        );
      if (content instanceof Error) return content;
      // A killed process can leave an incomplete final JSON line.
      const complete = content.slice(0, content.lastIndexOf("\n") + 1);
      if (complete.length === 0) continue;
      const lines = complete.trimEnd().split("\n");
      const parsed = errore.try({
        // SAFETY: These records were written by RunTrace to the private spool.
        try: () => lines.map((line) => JSON.parse(line) as TraceRecord),
        catch: (cause) =>
          new TraceStorageError({ operation: "read trace records", cause }),
      });
      if (parsed instanceof Error) return parsed;
      const first = parsed[0]!;
      const last = parsed.at(-1)!;
      const truncated = await fs
        .truncate(filePath, Buffer.byteLength(complete))
        .catch(
          (cause) =>
            new TraceStorageError({
              operation: "repair interrupted record",
              cause,
            }),
        );
      if (truncated instanceof Error) return truncated;
      if (last.type !== "run.finished") {
        const run = new RunTrace({
          ...first,
          filePath,
          sequence: last.sequence + 1,
        });
        const ended = await run.finish("interrupted");
        if (ended instanceof Error) return ended;
      }
      const archived = await this.archive(first.sessionId, first.traceId);
      if (archived instanceof Error) return archived;
    }
  }

  private scheduleUpload() {
    if (this.closed || this.uploader === undefined) return;
    // oxlint-disable-next-line typescript/no-floating-promises -- The queue owns background uploads; close() drains it and failures remain in the spool.
    this.actionQueue.run(async () => {
      if (this.closed) return;
      const uploaded = await this.uploadPending();
      if (uploaded instanceof Error) this.report(uploaded);
    });
  }

  private async uploadPending() {
    const uploader = this.uploader;
    if (uploader === undefined) return;
    const pending = path.join(this.directory, "pending");
    const files = await traceFiles(pending);
    if (files instanceof Error) return files;
    for (const key of files.filter((file) => file.endsWith(".jsonl.gz"))) {
      if (this.closed) return;
      const filePath = path.join(pending, key);
      const uploaded = await uploader.upload({
        key: key.split(path.sep).join("/"),
        filePath,
      });
      if (uploaded instanceof Error) return uploaded;
      const destination = path.join(this.directory, "archive", key);
      const created = await fs
        .mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
        .catch(
          (cause) =>
            new TraceStorageError({
              operation: "create uploaded directory",
              cause,
            }),
        );
      if (created instanceof Error) return created;
      const moved = await fs
        .rename(filePath, destination)
        .catch(
          (cause) =>
            new TraceStorageError({ operation: "acknowledge upload", cause }),
        );
      if (moved instanceof Error) return moved;
    }
  }
}

async function traceFiles(directory: string) {
  const files = await fs
    .readdir(directory, { recursive: true, withFileTypes: true })
    .catch((cause: NodeJS.ErrnoException) =>
      cause.code === "ENOENT"
        ? []
        : new TraceStorageError({ operation: "list traces", cause }),
    );
  if (files instanceof Error) return files;
  return files
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(directory, path.join(entry.parentPath, entry.name)),
    );
}
