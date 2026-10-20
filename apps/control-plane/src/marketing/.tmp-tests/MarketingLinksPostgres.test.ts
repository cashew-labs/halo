import crypto from "node:crypto";
import { Pool } from "pg";
import * as errore from "errore";
import { expect, test } from "vitest";
import { DatabaseService } from "../../DatabaseService.js";
import {
  MarketingLinks,
  MarketingLinkConflictError,
} from "../MarketingLinks.js";

const postgresUrl = process.env.HALO_MARKETING_TEST_POSTGRES_URL;
const postgresTest = test
  .skipIf(postgresUrl === undefined)
  .extend<{ connectionString: string }>({
    // oxlint-disable-next-line no-empty-pattern -- Native Vitest fixture signature.
    connectionString: async ({}, use) => {
      const admin = new Pool({ connectionString: postgresUrl });
      await using cleanup = new errore.AsyncDisposableStack();
      cleanup.defer(async () => await admin.end());
      const schema = `marketing_${crypto.randomUUID().replaceAll("-", "")}`;
      // Identifiers are generated locally from a fixed prefix and hexadecimal UUID.
      await admin.query(`CREATE SCHEMA ${schema}`);
      cleanup.defer(async () => {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      });
      const url = new URL(postgresUrl!);
      url.searchParams.set("options", `-c search_path=${schema}`);
      await use(url.href);
    },
  });
postgresTest(
  "PostgreSQL replicas share campaign changes and atomically reject duplicate slugs",
  async ({ connectionString }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const first = await DatabaseService.start({
      type: "postgres",
      connectionString,
    });
    if (first instanceof Error) throw first;
    cleanup.defer(async () => {
      await first.close();
    });
    const second = await DatabaseService.start({
      type: "postgres",
      connectionString,
    });
    if (second instanceof Error) throw second;
    cleanup.defer(async () => {
      await second.close();
    });
    const a = new MarketingLinks({
      database: first.appDatabase,
      adminUserIds: ["admin"],
    });
    const b = new MarketingLinks({
      database: second.appDatabase,
      adminUserIds: ["admin"],
    });
    expect(await a.initialize()).not.toBeInstanceOf(Error);
    expect(await b.initialize()).not.toBeInstanceOf(Error);
    const tags = {
      utm_source: "email",
      utm_medium: "newsletter",
      utm_campaign: "launch",
    };
    const input = { ownerUserId: "admin", slug: "launch", tags };
    const results = await Promise.all([a.create(input), b.create(input)]);
    expect(
      results.filter((r) => r instanceof MarketingLinkConflictError),
    ).toHaveLength(1);
    expect(results.filter((r) => !(r instanceof Error))).toHaveLength(1);
    expect(await b.resolve("launch")).toEqual({
      ...tags,
      utm_content: undefined,
      utm_term: undefined,
    });
    expect(
      await b.update({
        ...input,
        tags: { ...tags, utm_content: "changed" },
        enabled: false,
      }),
    ).not.toBeInstanceOf(Error);
    expect(await a.resolve("launch")).toBeUndefined();
    expect(await a.list("admin")).toMatchObject([
      { slug: "launch", enabled: false, tags: { utm_content: "changed" } },
    ]);
    await a.update({ ...input, enabled: true });
    expect(await b.resolve("launch")).toEqual({
      ...tags,
      utm_content: undefined,
      utm_term: undefined,
    });
    expect(
      await b.remove({ ownerUserId: "admin", slug: "launch" }),
    ).toBeUndefined();
    expect(await a.list("admin")).toEqual([]);
  },
);
