import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { GoogleAuth } from "google-auth-library";
import type { AppDomainTls } from "./AppDomains.js";
import { AppDomainHostError } from "./AppDomains.js";

const resourceSchema = Type.Object({
  name: Type.Optional(Type.String()),
  done: Type.Optional(Type.Boolean()),
  error: Type.Optional(Type.Object({ message: Type.Optional(Type.String()) })),
  dnsResourceRecord: Type.Optional(
    Type.Object({
      name: Type.String(),
      type: Type.Literal("CNAME"),
      data: Type.String(),
    }),
  ),
  managed: Type.Optional(Type.Object({ state: Type.Optional(Type.String()) })),
  state: Type.Optional(Type.String()),
});

/** Certificate Manager resources use server-generated IDs, never caller-supplied paths. */
export class GoogleAppDomainTls implements AppDomainTls {
  private readonly auth: Pick<GoogleAuth, "getAccessToken">;
  private readonly parent: string;
  private readonly certificateMap: string;
  private readonly address: string;
  private readonly apiOrigin: string;
  constructor(ctx: {
    auth: Pick<GoogleAuth, "getAccessToken">;
    projectId: string;
    certificateMap: string;
    address: string;
    apiOrigin?: string;
  }) {
    this.auth = ctx.auth;
    this.parent = `projects/${ctx.projectId}/locations/global`;
    this.certificateMap = `${this.parent}/certificateMaps/${ctx.certificateMap}`;
    this.address = ctx.address;
    this.apiOrigin =
      ctx.apiOrigin ?? "https://certificatemanager.googleapis.com";
  }
  routingRecords(hostname: string) {
    return [{ name: hostname, type: "A" as const, value: this.address }];
  }
  async ensure(ctx: { domainId: string; hostname: string }) {
    const resourceId = `halo-domain-${ctx.domainId}`;
    const authName = `${this.parent}/dnsAuthorizations/${resourceId}`;
    const certificateName = `${this.parent}/certificates/${resourceId}`;
    const entryName = `${this.certificateMap}/certificateMapEntries/${resourceId}`;
    const authorization = await this.request({ path: authName });
    if (authorization instanceof Error) return authorization;
    if (authorization === undefined) {
      const created = await this.request({
        method: "POST",
        path: `${this.parent}/dnsAuthorizations?dnsAuthorizationId=${resourceId}`,
        body: { domain: ctx.hostname, type: "PER_PROJECT_RECORD" },
      });
      if (created instanceof Error) return created;
      return { ready: false, records: [] };
    }
    const record = authorization.dnsResourceRecord;
    if (record === undefined)
      return new AppDomainHostError({
        operation:
          "Certificate Manager returned no DNS authorization record; verify again after provisioning",
      });
    const records = [
      { name: record.name, type: record.type, value: record.data },
    ];
    const certificate = await this.request({ path: certificateName });
    if (certificate instanceof Error) return certificate;
    if (certificate === undefined) {
      const created = await this.request({
        method: "POST",
        path: `${this.parent}/certificates?certificateId=${resourceId}`,
        body: {
          managed: { domains: [ctx.hostname], dnsAuthorizations: [authName] },
        },
      });
      if (created instanceof Error) return created;
      return { ready: false, records };
    }
    if (certificate.managed?.state === "FAILED") {
      // FAILED is terminal. Keep its DNS authorization stable while allowing a
      // later verification to recreate the certificate after DNS is corrected.
      for (const path of [entryName, certificateName]) {
        const removed = await this.removeResource(path);
        if (removed instanceof Error) return removed;
      }
      return { ready: false, records };
    }
    if (certificate.managed?.state !== "ACTIVE")
      return { ready: false, records };
    const entry = await this.request({ path: entryName });
    if (entry instanceof Error) return entry;
    if (entry === undefined) {
      const created = await this.request({
        method: "POST",
        path: `${this.certificateMap}/certificateMapEntries?certificateMapEntryId=${resourceId}`,
        body: { hostname: ctx.hostname, certificates: [certificateName] },
      });
      if (created instanceof Error) return created;
      return { ready: false, records };
    }
    return { ready: entry.state === "ACTIVE", records };
  }
  async remove(ctx: { domainId: string }) {
    const resourceId = `halo-domain-${ctx.domainId}`;
    for (const path of [
      `${this.certificateMap}/certificateMapEntries/${resourceId}`,
      `${this.parent}/certificates/${resourceId}`,
      `${this.parent}/dnsAuthorizations/${resourceId}`,
    ]) {
      const removed = await this.removeResource(path);
      if (removed instanceof Error) return removed;
    }
  }
  private async removeResource(path: string) {
    const operation = await this.request({ method: "DELETE", path });
    if (operation instanceof Error) return operation;
    if (operation?.name !== undefined && operation.done !== true) {
      // A referenced certificate cannot be deleted before its map entry is gone.
      const completed = await this.request({ path: operation.name });
      if (completed instanceof Error) return completed;
      if (completed?.done !== true)
        return new AppDomainHostError({
          operation:
            "Certificate cleanup is still running. Repeat this domain command to finish.",
        });
    }
  }
  private async request(ctx: {
    path: string;
    method?: "POST" | "DELETE";
    body?: object;
  }) {
    const token = await this.auth.getAccessToken().catch(
      (cause) =>
        new AppDomainHostError({
          operation: "authenticate to Certificate Manager",
          cause,
        }),
    );
    if (token instanceof Error) return token;
    if (token === null)
      return new AppDomainHostError({
        operation: "Certificate Manager credentials are unavailable",
      });
    const response = await fetch(`${this.apiOrigin}/v1/${ctx.path}`, {
      method: ctx.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: ctx.body === undefined ? undefined : JSON.stringify(ctx.body),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    }).catch(
      (cause) =>
        new AppDomainHostError({
          operation: "call Certificate Manager",
          cause,
        }),
    );
    if (response instanceof Error) return response;
    if (response.status === 404 && ctx.method !== "POST") return undefined;
    // Concurrent/retried creates use the same ID and converge on the next GET.
    if (response.status === 409 && ctx.method === "POST") return undefined;
    if (!response.ok)
      return new AppDomainHostError({
        operation: `Certificate Manager returned HTTP ${response.status}`,
      });
    if (response.status === 204) return undefined;
    const resource: unknown = await response.json().catch(
      (cause) =>
        new AppDomainHostError({
          operation: "read Certificate Manager response",
          cause,
        }),
    );
    if (resource instanceof Error) return resource;
    if (!Value.Check(resourceSchema, resource))
      return new AppDomainHostError({
        operation: "Certificate Manager returned an invalid resource",
      });
    if (resource.error !== undefined)
      return new AppDomainHostError({
        operation:
          "Certificate Manager operation failed; retry the domain command",
      });
    return resource;
  }
}
