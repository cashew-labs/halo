import fs from "node:fs/promises";
import type { GoogleAuth } from "google-auth-library";
import * as errore from "errore";
import type { TraceUploader } from "./TraceService.js";

class GcsTraceUploadError extends errore.createTaggedError({
  name: "GcsTraceUploadError",
  message: "Could not upload trace '$key'",
}) {}

export class GcsTraceUploader implements TraceUploader {
  private readonly bucket: string;
  private readonly origin: string;
  private readonly auth: GoogleAuth;

  constructor(ctx: { bucket: string; origin: string; auth: GoogleAuth }) {
    const { bucket, origin, auth } = ctx;
    this.bucket = bucket;
    this.origin = origin;
    this.auth = auth;
  }

  async upload(input: { key: string; filePath: string }) {
    const opened = await fs
      .open(input.filePath, "r")
      .catch((cause) => new GcsTraceUploadError({ key: input.key, cause }));
    if (opened instanceof Error) return opened;
    await using file = opened;
    const url = new URL(
      `/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`,
      this.origin,
    );
    url.searchParams.set("uploadType", "media");
    url.searchParams.set("name", input.key);
    url.searchParams.set("ifGenerationMatch", "0");
    using cleanup = new errore.DisposableStack();
    const body = file.createReadStream({ autoClose: false });
    cleanup.defer(() => body.destroy());
    const response = await this.auth
      .request({
        url: url.toString(),
        method: "POST",
        headers: { "content-type": "application/gzip" },
        data: body,
        timeout: 20_000,
        retry: false,
        // GCS returns 412 when this immutable key already exists, including when
        // a previous successful upload's acknowledgement was lost.
        validateStatus: (status) =>
          (status >= 200 && status < 300) || status === 412,
      })
      .catch((cause) => new GcsTraceUploadError({ key: input.key, cause }));
    if (response instanceof Error) return response;
  }
}
