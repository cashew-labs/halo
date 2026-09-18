import fs from "node:fs/promises";
import type { GoogleAuth } from "google-auth-library";
import * as errore from "errore";
import type { TraceUploader } from "./TraceService.js";

class TraceUploadError extends errore.createTaggedError({
  name: "TraceUploadError",
  message: "Could not upload trace '$key'",
}) {}

export class ControlPlaneTraceUploader implements TraceUploader {
  private readonly origin: string;
  private readonly auth: Pick<GoogleAuth, "getIdTokenClient">;

  constructor(ctx: {
    origin: string;
    auth: Pick<GoogleAuth, "getIdTokenClient">;
  }) {
    const { origin, auth } = ctx;
    this.origin = origin;
    this.auth = auth;
  }

  async upload(input: { key: string; filePath: string }) {
    const match =
      /^v1\/workspaces\/[^/]+\/sessions\/([a-zA-Z0-9_-]{1,128})\/([0-9a-f]{32})\.jsonl\.gz$/.exec(
        input.key,
      );
    if (match === null) return new TraceUploadError({ key: input.key });
    const client = await this.auth
      .getIdTokenClient(new URL("/api/traces", this.origin).toString())
      .catch((cause) => new TraceUploadError({ key: input.key, cause }));
    if (client instanceof Error) return client;
    const opened = await fs
      .open(input.filePath, "r")
      .catch((cause) => new TraceUploadError({ key: input.key, cause }));
    if (opened instanceof Error) return opened;
    await using file = opened;
    using cleanup = new errore.DisposableStack();
    const body = file.createReadStream({ autoClose: false });
    cleanup.defer(() => body.destroy());
    const response = await client
      .request({
        url: new URL(
          `/api/traces/${match[1]}/${match[2]}`,
          this.origin,
        ).toString(),
        method: "POST",
        headers: { "content-type": "application/gzip" },
        data: body,
        timeout: 60_000,
        retry: false,
      })
      .catch((cause) => new TraceUploadError({ key: input.key, cause }));
    if (response instanceof Error) return response;
  }
}
