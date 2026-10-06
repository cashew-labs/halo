import fs from "node:fs/promises";
import stream from "node:stream";
import * as errore from "errore";
import type { TraceUploader } from "./TraceService.js";

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
      /^v1\/workspaces\/[^/]+\/sessions\/([a-zA-Z0-9_-]{1,128})\/([0-9a-f]{32})\.jsonl\.gz$/.exec(
        input.key,
      );
    if (match === null) return new TraceUploadError({ key: input.key });
    const opened = await fs
      .open(input.filePath, "r")
      .catch((cause) => new TraceUploadError({ key: input.key, cause }));
    if (opened instanceof Error) return opened;
    await using file = opened;
    using cleanup = new errore.DisposableStack();
    const body = file.createReadStream({ autoClose: false });
    cleanup.defer(() => body.destroy());
    const options = {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/gzip",
      },
      // SAFETY: fs.createReadStream emits byte buffers; toWeb preserves their chunks.
      body: stream.Readable.toWeb(body) as ReadableStream<Uint8Array>,
      duplex: "half" as const,
      signal: AbortSignal.timeout(60_000),
      redirect: "error" as const,
    };
    const response = await fetch(
      new URL(`/api/traces/${match[1]}/${match[2]}`, this.origin),
      options,
    ).catch((cause) => new TraceUploadError({ key: input.key, cause }));
    if (response instanceof Error) return response;
    const closed = await response.body
      ?.cancel()
      .catch((cause) => new TraceUploadError({ key: input.key, cause }));
    if (closed instanceof Error) return closed;
    if (!response.ok) return new TraceUploadError({ key: input.key });
  }
}
