import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";

export class TraceIdentityError extends errore.createTaggedError({
  name: "TraceIdentityError",
  message: "Trace upload identity rejected: $detail",
}) {}

class TraceCloudError extends errore.createTaggedError({
  name: "TraceCloudError",
  message: "Trace cloud request failed: $detail",
}) {}

const identitySchema = Type.Object({
  email: Type.String(),
  email_verified: Type.Literal(true),
  google: Type.Object({
    compute_engine: Type.Object({
      project_id: Type.String(),
      zone: Type.String(),
      instance_id: Type.String({ pattern: "^[0-9]+$" }),
      instance_name: Type.String({
        pattern:
          "^halo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
      }),
    }),
  }),
});

export class TraceCloud {
  private readonly bucket: string;
  private readonly projectId: string;
  private readonly zone: string;
  private readonly serviceAccount: string;
  private readonly auth: GoogleAuth;
  private readonly verifier: OAuth2Client;
  private readonly storageOrigin: string;
  private readonly computeOrigin: string;

  constructor(ctx: {
    bucket: string;
    projectId: string;
    zone: string;
    serviceAccount: string;
    auth: GoogleAuth;
    verifier: OAuth2Client;
    storageOrigin: string;
    computeOrigin: string;
  }) {
    const {
      bucket,
      projectId,
      zone,
      serviceAccount,
      auth,
      verifier,
      storageOrigin,
      computeOrigin,
    } = ctx;
    this.bucket = bucket;
    this.projectId = projectId;
    this.zone = zone;
    this.serviceAccount = serviceAccount;
    this.auth = auth;
    this.verifier = verifier;
    this.storageOrigin = storageOrigin;
    this.computeOrigin = computeOrigin;
  }

  async authenticate(authorization: string | undefined, audience: string) {
    if (authorization === undefined || !authorization.startsWith("Bearer "))
      return new TraceIdentityError({ detail: "missing bearer token" });
    const ticket = await this.verifier
      .verifyIdToken({
        idToken: authorization.slice(7),
        audience,
      })
      .catch(
        (cause) =>
          new TraceIdentityError({
            detail: "invalid Google identity token",
            cause,
          }),
      );
    if (ticket instanceof Error) return ticket;
    const payload = ticket.getPayload();
    // Full GCE identity tokens carry signed instance claims; a shared service-account token alone is insufficient.
    if (!Value.Check(identitySchema, payload))
      return new TraceIdentityError({ detail: "missing VM identity" });
    const instance = payload.google.compute_engine;
    if (
      payload.email !== this.serviceAccount ||
      instance.project_id !== this.projectId ||
      instance.zone !== this.zone
    )
      return new TraceIdentityError({ detail: "unexpected VM identity" });
    const current = await this.auth
      .request<{ id: string }>({
        url: new URL(
          `/compute/v1/projects/${this.projectId}/zones/${this.zone}/instances/${instance.instance_name}`,
          this.computeOrigin,
        ).toString(),
        timeout: 20_000,
        retry: false,
        validateStatus: (status) => status === 200 || status === 404,
      })
      .catch(
        (cause) => new TraceCloudError({ detail: "verify current VM", cause }),
      );
    if (current instanceof Error) return current;
    if (current.status === 404 || current.data.id !== instance.instance_id)
      return new TraceIdentityError({
        detail: "VM no longer matches its token",
      });
    return instance.instance_name.slice("halo-".length);
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
      this.storageOrigin,
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
