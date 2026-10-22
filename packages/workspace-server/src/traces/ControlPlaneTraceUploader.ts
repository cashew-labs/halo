import crypto from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import { promisify } from "node:util";
import { createGunzip, gunzip, gzip } from "node:zlib";
import { traceUploadLimits } from "@get-halo/client/traces";
import * as errore from "errore";
import {
  TraceUploadRejectedError,
  type TraceUploader,
} from "./TraceService.js";

const decompress = promisify(gunzip);
const compress = promisify(gzip);
const previewLimitBytes = 64 * 1024;

type ArchiveIdentity = {
  workspaceId: string;
  threadId: string;
  traceId: string;
};

class TraceUploadError extends errore.createTaggedError({
  name: "TraceUploadError",
  message: "Could not upload trace '$key'",
}) {}

export class ControlPlaneTraceUploader implements TraceUploader {
  private readonly origin: string;
  private readonly token: string;

  constructor(ctx: { origin: string; token: string }) {
    const { origin, token } = ctx;
    this.origin = origin;
    this.token = token;
  }

  async upload(input: { key: string; filePath: string }) {
    const match =
      /^v1\/workspaces\/([^/]+)\/sessions\/([a-zA-Z0-9_-]{1,128})\/([0-9a-f]{32})\.jsonl\.gz$/.exec(
        input.key,
      );
    if (match === null)
      return new TraceUploadRejectedError({
        key: input.key,
        reason: "invalid archive key",
      });
    const opened = await fs
      .open(input.filePath, "r")
      .catch((cause) => new TraceUploadError({ key: input.key, cause }));
    if (opened instanceof Error) return opened;
    await using file = opened;
    const metadata = await file
      .stat()
      // coverage-exempt: An already-open immutable archive handle rarely fails stat; exercising this requires mocking fs internals.
      .catch((cause) => new TraceUploadError({ key: input.key, cause }));

    if (metadata instanceof Error) return metadata;
    const identity = {
      workspaceId: match[1]!,
      threadId: match[2]!,
      traceId: match[3]!,
    };
    const prepared = await this.prepare(
      file,
      input.key,
      identity,
      metadata.size,
    );
    if (prepared instanceof Error) return prepared;
    const response = await fetch(
      new URL(
        `/api/traces/${identity.threadId}/${identity.traceId}`,
        this.origin,
      ),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/gzip",
          "content-length": prepared.body.length.toString(),
        },
        body: new Uint8Array(prepared.body),
        signal: AbortSignal.timeout(60_000),
        redirect: "error",
      },
    ).catch((cause) => new TraceUploadError({ key: input.key, cause }));
    if (response instanceof Error) return response;
    const closed = await response.body
      ?.cancel()
      .catch((cause) => new TraceUploadError({ key: input.key, cause }));
    if ([400, 413, 415, 422].includes(response.status))
      return new TraceUploadRejectedError({
        key: input.key,
        reason: `HTTP ${response.status}`,
      });
    if (closed instanceof Error) return closed;
    if (!response.ok) return new TraceUploadError({ key: input.key });
    if (prepared.partial !== undefined)
      return { partial: true as const, reason: prepared.partial };
  }

  private async prepare(
    file: FileHandle,
    key: string,
    identity: ArchiveIdentity,
    compressedBytes: number,
  ) {
    if (compressedBytes > traceUploadLimits.compressedBytes)
      return await this.report(
        file,
        key,
        identity,
        compressedBytes,
        "compressed size limit exceeded",
      );
    const archive = await file
      .readFile()
      .catch((cause) => new TraceUploadError({ key, cause }));
    if (archive instanceof Error) return archive;
    const validated = await decompress(archive, {
      maxOutputLength: traceUploadLimits.expandedBytes,
    })
      .then(() => undefined)
      .catch(
        (cause) =>
          new TraceUploadRejectedError({
            key,
            reason:
              cause instanceof Error &&
              "code" in cause &&
              cause.code === "ERR_BUFFER_TOO_LARGE"
                ? "expanded size limit exceeded"
                : "invalid gzip",
            cause,
          }),
      );
    if (
      validated instanceof TraceUploadRejectedError &&
      validated.reason === "expanded size limit exceeded"
    )
      return await this.report(
        file,
        key,
        identity,
        compressedBytes,
        validated.reason,
      );
    if (validated instanceof Error) return validated;
    return { body: archive, partial: undefined };
  }

  private async report(
    file: FileHandle,
    key: string,
    identity: ArchiveIdentity,
    compressedBytes: number,
    reason: string,
  ) {
    const preview = await readPreview(file).catch(
      (cause) => new TraceUploadError({ key, cause }),
    );
    const spanId = crypto.randomBytes(8).toString("hex");
    const envelope = {
      workspaceId: identity.workspaceId,
      sessionId: identity.threadId,
      traceId: identity.traceId,
      schemaVersion: 1,
      spanId,
      timestamp: new Date().toISOString(),
    };
    // This is a report about an archive, not a fabricated result of the original agent run.
    const records = [
      {
        ...envelope,
        sequence: 0,
        type: "run.started",
        data: { kind: "archive-upload-report" },
      },
      {
        ...envelope,
        sequence: 1,
        type: "archive.truncated",
        data: {
          reason,
          compressedBytes,
          limits: traceUploadLimits,
          previewLimitBytes,
          previewReadFailed: preview instanceof Error,
          preview: preview instanceof Error ? "" : preview,
        },
      },
      {
        ...envelope,
        sequence: 2,
        type: "run.finished",
        data: { kind: "archive-upload-report", fullArchiveUploaded: false },
      },
    ];
    const body = await compress(
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    )
      // coverage-exempt: Compressing a small generated JSON report fails only for native zlib/resource errors; no external input affects its validity.
      .catch((cause) => new TraceUploadError({ key, cause }));

    if (body instanceof Error) return body;
    return { body, partial: reason };
  }
}

async function readPreview(file: FileHandle) {
  const source = file
    .createReadStream({ autoClose: false, start: 0 })
    .compose(createGunzip());
  using cleanup = new errore.DisposableStack();
  cleanup.defer(() => source.destroy());
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of source) {
    // SAFETY: The file and gunzip streams emit Buffer chunks only.
    const buffer = chunk as Buffer;
    const kept = buffer.subarray(0, previewLimitBytes - bytes);
    chunks.push(kept);
    bytes += kept.length;
    if (bytes === previewLimitBytes) break;
  }
  const prefix = Buffer.concat(chunks);
  // Omit a cut-off JSONL record; the report carries only complete beginning lines.
  return prefix.subarray(0, prefix.lastIndexOf(10) + 1).toString("utf8");
}
