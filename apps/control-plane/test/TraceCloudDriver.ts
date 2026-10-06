import { GoogleAuth } from "google-auth-library";
import { TraceCloud } from "../src/traces/TraceCloud.js";

/** Real GCS test storage. Successful uploads require HALO_TEST_TRACE_BUCKET and ADC. */
export class TraceCloudDriver {
  // Owns only disposable object names reserved by this fixture.
  private readonly keys = new Set<string>();
  private readonly auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  private readonly bucket =
    process.env.HALO_TEST_TRACE_BUCKET ?? "unconfigured-trace-tests";

  cloud() {
    return new TraceCloud({ bucket: this.bucket, auth: this.auth });
  }

  track(key: string) {
    this.keys.add(key);
  }

  async read(key: string) {
    const url = this.objectUrl(key);
    url.searchParams.set("alt", "media");
    const response = await this.auth.request<ArrayBuffer>({
      url: url.toString(),
      responseType: "arraybuffer",
      retry: false,
      timeout: 20_000,
    });
    return Buffer.from(response.data);
  }

  async close() {
    for (const key of this.keys) {
      await this.auth.request({
        url: this.objectUrl(key).toString(),
        method: "DELETE",
        retry: false,
        timeout: 20_000,
        validateStatus: (status) => status === 204 || status === 404,
      });
    }
  }

  private objectUrl(key: string) {
    return new URL(
      `/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}`,
      "https://storage.googleapis.com",
    );
  }
}
