import crypto from "node:crypto";
import fs from "node:fs/promises";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import type { TraceEvent, TraceRecord, TraceOutcome } from "@get-halo/client";
import * as errore from "errore";

export class TraceStorageError extends errore.createTaggedError({
  name: "TraceStorageError",
  message: "Trace storage failed during $operation",
}) {}

export class RunTrace {
  // Orders records and completion within this run.
  private readonly actionQueue = new SerialQueue();
  // Assigns a stable order independent of timestamps.
  private sequence: number;
  // Rejects records after the run's terminal event.
  private finished = false;
  // Prevents publishing a successful-looking archive after a failed write.
  private writeError: TraceStorageError | undefined;

  readonly traceId: string;
  readonly spanId: string;
  readonly sessionId: string;
  private readonly workspaceId: string;
  private readonly filePath: string;

  constructor(ctx: {
    workspaceId: string;
    sessionId: string;
    traceId: string;
    spanId: string;
    filePath: string;
    sequence: number;
  }) {
    const { workspaceId, sessionId, traceId, spanId, filePath, sequence } = ctx;
    this.workspaceId = workspaceId;
    this.sessionId = sessionId;
    this.traceId = traceId;
    this.spanId = spanId;
    this.filePath = filePath;
    this.sequence = sequence;
  }

  static spanId() {
    return crypto.randomBytes(8).toString("hex");
  }

  async record(event: TraceEvent) {
    if (this.finished)
      return new TraceStorageError({ operation: "append to a finished run" });
    return await this.append(event);
  }

  async finish(outcome: TraceOutcome) {
    if (this.finished)
      return new TraceStorageError({
        operation: "finish an already finished run",
      });
    this.finished = true;
    return await this.append({
      type: "run.finished",
      spanId: this.spanId,
      data: { outcome },
    });
  }

  private async append(event: TraceEvent) {
    const record: TraceRecord = {
      ...event,
      schemaVersion: 1,
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
      traceId: this.traceId,
      sequence: this.sequence++,
      timestamp: new Date().toISOString(),
    };
    // Serialize before yielding: Pi mutates streaming messages in place.
    const line = errore.try({
      try: () => `${JSON.stringify(record)}\n`,
      catch: (cause) =>
        new TraceStorageError({ operation: "serialize record", cause }),
    });
    return await this.actionQueue.run(async () => {
      if (this.writeError !== undefined) return this.writeError;
      if (line instanceof Error) {
        this.writeError = line;
        return line;
      }
      const written = await fs
        .appendFile(this.filePath, line, { mode: 0o600, flush: true })
        .catch(
          (cause) =>
            new TraceStorageError({ operation: "append record", cause }),
        );
      if (written instanceof Error) this.writeError = written;
      return written;
    });
  }
}
