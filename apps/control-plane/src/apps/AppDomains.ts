// oxlint-disable unicorn/no-null -- SQL uses NULL for unverified domains.
import crypto from "node:crypto";
import dns from "node:dns/promises";
import { domainToASCII } from "node:url";
import * as errore from "errore";
import type { AppDomain, AppDomainDnsRecord } from "@get-halo/client";
import type { SqlDatabase } from "../database/SqlDatabase.js";
import type { AppStore } from "./AppStore.js";

export class AppDomainRequestError extends errore.createTaggedError({
  name: "AppDomainRequestError",
  message: "$reason",
}) {}
export class AppDomainHostError extends errore.createTaggedError({
  name: "AppDomainHostError",
  message: "Domain hosting failed: $operation",
}) {}

export interface AppDomainTls {
  /** Idempotent; returns DNS records while a managed certificate is provisioning. */
  ensure(input: {
    domainId: string;
    hostname: string;
  }): Promise<{ ready: boolean; records: AppDomainDnsRecord[] } | Error>;
  remove(input: { domainId: string }): Promise<void | Error>;
  routingRecords(hostname: string): AppDomainDnsRecord[];
}
export type AppDomainDns = (hostname: string) => Promise<string[][] | Error>;
const resolveDomainTxt: AppDomainDns = async (hostname) =>
  await dns.resolveTxt(hostname).catch((cause: NodeJS.ErrnoException) =>
    cause.code === "ENODATA" || cause.code === "ENOTFOUND"
      ? []
      : new AppDomainHostError({
          operation: "read DNS verification record",
          cause,
        }),
  );

type DomainRow = {
  domain_id: string;
  app_id: string;
  hostname: string;
  token: string;
  active: number;
  verified_at: number | null;
  records: string;
};
const columns =
  "domain_id, app_id, hostname, token, active, verified_at, records";

/** Owns DNS challenges and hostname bindings; extension data stays on the app VM. */
export class AppDomains {
  private readonly database: SqlDatabase;
  private readonly apps: AppStore;
  private readonly publicHostname: string;
  private readonly tls: AppDomainTls | undefined;
  private readonly resolveTxt: AppDomainDns;
  constructor(ctx: {
    database: SqlDatabase;
    apps: AppStore;
    publicOrigin: string;
    tls?: AppDomainTls;
    resolveTxt?: AppDomainDns;
  }) {
    this.database = ctx.database;
    this.apps = ctx.apps;
    this.publicHostname = new URL(ctx.publicOrigin).hostname;
    this.tls = ctx.tls;
    this.resolveTxt = ctx.resolveTxt ?? resolveDomainTxt;
  }
  async initialize() {
    const created = await this.database
      .query(`CREATE TABLE IF NOT EXISTS app_domains (
      domain_id TEXT PRIMARY KEY, app_id TEXT NOT NULL, hostname TEXT NOT NULL,
      token TEXT NOT NULL, verified_at BIGINT, active INTEGER NOT NULL, records TEXT NOT NULL DEFAULT '[]',
      UNIQUE (app_id, hostname))`);
    if (created instanceof Error) return created;
    return await this.database.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS app_domains_verified_hostname ON app_domains (hostname) WHERE verified_at IS NOT NULL",
    );
  }
  async add(ctx: { ownerUserId: string; appId: string; hostname: string }) {
    const app = await this.owned(ctx);
    if (app instanceof Error) return app;
    if (this.tls === undefined)
      return new AppDomainRequestError({
        reason: "Custom domains are not configured on this Halo deployment",
      });
    const hostname = domainToASCII(
      ctx.hostname.toLowerCase().replace(/\.$/, ""),
    );
    if (
      hostname.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(
        hostname,
      )
    )
      return new AppDomainRequestError({
        reason:
          "Enter a DNS hostname without a scheme, port, path, or wildcard",
      });
    // Halo's own application and creator origins cannot become extension origins.
    if (
      hostname === this.publicHostname ||
      (hostname.endsWith(`.${this.publicHostname}`) &&
        hostname !== `go.${this.publicHostname}`)
    )
      return new AppDomainRequestError({
        reason: "This hostname is reserved for Halo",
      });
    const result = await this.database.transaction(async (sql) => {
      const rows = await sql.query<DomainRow>(
        `SELECT ${columns} FROM app_domains WHERE app_id = $1 AND hostname = $2`,
        [ctx.appId, hostname],
      );
      if (rows instanceof Error) return rows;
      if (rows[0] !== undefined) return rows[0];
      // Pending challenges do not reserve a hostname globally; only proof can claim it.
      const count = await sql.query(
        "SELECT domain_id FROM app_domains WHERE app_id = $1",
        [ctx.appId],
      );
      if (count instanceof Error) return count;
      if (count.length >= 10)
        return new AppDomainRequestError({
          reason:
            "An app can have at most 10 custom domains. Remove one before adding another.",
        });
      const row: DomainRow = {
        domain_id: crypto.randomUUID(),
        app_id: ctx.appId,
        hostname,
        token: crypto.randomBytes(32).toString("base64url"),
        active: 0,
        verified_at: null,
        records: "[]",
      };
      const added = await sql.query(
        "INSERT INTO app_domains (domain_id, app_id, hostname, token, active) VALUES ($1,$2,$3,$4,0)",
        [row.domain_id, row.app_id, hostname, row.token],
      );
      if (added instanceof Error) return added;
      return row;
    });
    if (result instanceof Error) return result;
    return this.summary(result);
  }
  async list(ctx: { ownerUserId: string; appId: string }) {
    const app = await this.owned(ctx);
    if (app instanceof Error) return app;
    const rows = await this.database.query<DomainRow>(
      `SELECT ${columns} FROM app_domains WHERE app_id = $1 ORDER BY hostname`,
      [ctx.appId],
    );
    if (rows instanceof Error) return rows;
    return rows.map((row) => this.summary(row));
  }
  async verify(ctx: { ownerUserId: string; appId: string; hostname: string }) {
    const row = await this.ownedDomain(ctx);
    if (row instanceof Error) return row;
    const app = await this.owned(ctx);
    if (app instanceof Error) return app;
    const records = await this.resolveTxt(`_halo-challenge.${row.hostname}`);
    if (records instanceof Error) return records;
    if (!records.some((parts) => parts.join("") === row.token)) {
      // Revoking a proof must also revoke an already-active route.
      const inactive = await this.database.query(
        "UPDATE app_domains SET active = 0, verified_at = NULL WHERE domain_id = $1",
        [row.domain_id],
      );
      if (inactive instanceof Error) return inactive;
      return new AppDomainRequestError({
        reason:
          "DNS verification record does not match. Add the returned TXT record, wait for DNS propagation, then verify again.",
      });
    }
    const verified = await this.database.transaction(async (sql) => {
      const competing = await sql.query(
        "SELECT domain_id FROM app_domains WHERE hostname = $1 AND verified_at IS NOT NULL AND domain_id <> $2",
        [row.hostname, row.domain_id],
      );
      if (competing instanceof Error) return competing;
      if (competing.length > 0)
        return new AppDomainRequestError({
          reason:
            "This hostname is already verified for another app. Remove that binding before verifying this one.",
        });
      return await sql.query(
        "UPDATE app_domains SET verified_at = $1 WHERE domain_id = $2",
        [Date.now(), row.domain_id],
      );
    });
    if (verified instanceof Error) return verified;
    if (this.tls === undefined)
      return new AppDomainRequestError({
        reason: "Custom domain HTTPS is not configured on this Halo deployment",
      });
    const certificate = await this.tls.ensure({
      domainId: row.domain_id,
      hostname: row.hostname,
    });
    if (certificate instanceof Error) return certificate;
    const saved = await this.database.query(
      "UPDATE app_domains SET records = $1, active = 0 WHERE domain_id = $2",
      [JSON.stringify(certificate.records), row.domain_id],
    );
    if (saved instanceof Error) return saved;
    if (certificate.ready) {
      const activated = await this.database.transaction(async (sql) => {
        const competing = await sql.query(
          "SELECT domain_id FROM app_domains WHERE hostname = $1 AND active = 1 AND domain_id <> $2",
          [row.hostname, row.domain_id],
        );
        if (competing instanceof Error) return competing;
        if (competing.length > 0)
          return new AppDomainRequestError({
            reason:
              "This hostname is already bound to another app. Remove that binding before verifying this one.",
          });
        return await sql.query(
          "UPDATE app_domains SET active = 1 WHERE domain_id = $1",
          [row.domain_id],
        );
      });
      if (activated instanceof Error) return activated;
    }
    return {
      ...this.summary({
        ...row,
        verified_at: Date.now(),
        active: certificate.ready ? 1 : 0,
      }),
      records: this.summary({
        ...row,
        records: JSON.stringify(certificate.records),
      }).records,
    };
  }
  async remove(ctx: { ownerUserId: string; appId: string; hostname: string }) {
    const row = await this.ownedDomain(ctx);
    if (row instanceof Error) return row;
    // Fail closed before external cleanup, and retain the row for retry on failure.
    const inactive = await this.database.query(
      "UPDATE app_domains SET active = 0 WHERE domain_id = $1",
      [row.domain_id],
    );
    if (inactive instanceof Error) return inactive;
    if (this.tls !== undefined) {
      const removed = await this.tls.remove({ domainId: row.domain_id });
      if (removed instanceof Error) return removed;
    }
    const removed = await this.database.query(
      "DELETE FROM app_domains WHERE domain_id = $1",
      [row.domain_id],
    );
    if (removed instanceof Error) return removed;
  }
  async listForRemoval(appId: string) {
    const rows = await this.database.query<DomainRow>(
      `SELECT ${columns} FROM app_domains WHERE app_id = $1`,
      [appId],
    );
    if (rows instanceof Error) return rows;
    return rows.map((row) => row.hostname);
  }
  async lookup(hostname: string) {
    const rows = await this.database.query<DomainRow>(
      `SELECT ${columns} FROM app_domains WHERE hostname = $1 AND active = 1`,
      [hostname],
    );
    if (rows instanceof Error) return rows;
    if (rows[0] === undefined) return undefined;
    const app = await this.apps.get(rows[0].app_id);
    if (app instanceof Error) return app;
    return app?.stage === "live" && app.published && app.visibility === "public"
      ? app
      : undefined;
  }
  private summary(row: DomainRow): AppDomain {
    return {
      hostname: row.hostname,
      appId: row.app_id,
      status:
        row.active === 1
          ? "active"
          : row.verified_at === null
            ? "pending"
            : "provisioning",
      records: [
        {
          name: `_halo-challenge.${row.hostname}`,
          type: "TXT",
          value: row.token,
        },
        ...(this.tls?.routingRecords(row.hostname) ?? []),
        // SAFETY: Only the typed TLS provider writes this internal JSON column.
        ...(JSON.parse(row.records) as AppDomainDnsRecord[]),
      ],
    };
  }
  private async owned(ctx: { ownerUserId: string; appId: string }) {
    const app = await this.apps.get(ctx.appId);
    if (app instanceof Error) return app;
    if (app === undefined || app.ownerUserId !== ctx.ownerUserId)
      return new AppDomainRequestError({ reason: "App not found" });
    if (app.stage !== "live" || !app.published || app.visibility !== "public")
      return new AppDomainRequestError({
        reason: "Publish this app publicly before managing custom domains",
      });
    return app;
  }
  private async ownedDomain(ctx: {
    ownerUserId: string;
    appId: string;
    hostname: string;
  }) {
    const app = await this.apps.get(ctx.appId);
    if (app instanceof Error) return app;
    if (app === undefined || app.ownerUserId !== ctx.ownerUserId)
      return new AppDomainRequestError({ reason: "App not found" });
    const hostname = domainToASCII(
      ctx.hostname.toLowerCase().replace(/\.$/, ""),
    );
    const rows = await this.database.query<DomainRow>(
      `SELECT ${columns} FROM app_domains WHERE app_id = $1 AND hostname = $2`,
      [ctx.appId, hostname],
    );
    if (rows instanceof Error) return rows;
    if (rows[0] === undefined)
      return new AppDomainRequestError({
        reason: "Custom domain not found. Add the domain first.",
      });
    return rows[0];
  }
}
