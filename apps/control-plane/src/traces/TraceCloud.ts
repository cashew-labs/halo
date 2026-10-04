import type { GoogleAuth } from "google-auth-library";
import * as errore from "errore";

class TraceCloudError extends errore.createTaggedError({
  name: "TraceCloudError",
  message: "Trace cloud request failed: $detail",
}) {}

export class TraceCloud {
  private readonly bucket: string;
  private readonly auth: GoogleAuth;

  constructor(ctx: { bucket: string; auth: GoogleAuth }) {
    this.bucket = ctx.bucket;
    this.auth = ctx.auth;
  }

  async upload(input: {
    workspaceId: string;
    sessionId: string;
    traceId: string;
    body: Buffer;
  }) {
    const key = `v1/workspaces/${input.workspaceId}/sessions/${input.sessionId}/${input.traceId}.jsonl.gz`;
    const url = new URL(
      `/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`,
      "https://storage.googleapis.com",
    );
    url.searchParams.set("uploadType", "media");
    url.searchParams.set("name", key);
    url.searchParams.set("ifGenerationMatch", "0");
    const response = await this.auth
      .request({
        url: url.toString(),
        method: "POST",
        headers: { "content-type": "application/gzip" },
        data: input.body,
        timeout: 20_000,
        retry: false,
        // Retrying an immutable object after a lost acknowledgement returns 412.
        validateStatus: (status) =>
          (status >= 200 && status < 300) || status === 412,
      })
      .catch(
        (cause) => new TraceCloudError({ detail: "store archive", cause }),
      );
    if (response instanceof Error) return response;
  }
}
