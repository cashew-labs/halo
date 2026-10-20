import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { DatabaseService } from "../../DatabaseService.js";
import {
  MarketingLinks,
  MarketingAdminRequiredError,
} from "../MarketingLinks.js";

const linksTest = test.extend<{ directory: string }>({
  directory: async ({ task }, use) => {
    const parent = path.resolve(
      import.meta.dirname,
      "../../../../../tmp/marketing-admin/databases",
    );
    await fs.mkdir(parent, { recursive: true });
    const directory = await fs.mkdtemp(path.join(parent, `${task.id}-`));
    await use(directory);
    await fs.rm(directory, { recursive: true, force: true });
  },
});
linksTest(
  "campaign tags and disabled state survive closing and reopening the server database",
  async ({ directory }) => {
    const config = {
      type: "sqlite" as const,
      path: path.join(directory, "control-plane.db"),
    };
    const tags = {
      utm_source: "email",
      utm_medium: "newsletter",
      utm_campaign: "launch",
      utm_content: "a&b",
      utm_term: "tag",
    };
    const first = await DatabaseService.start(config);
    if (first instanceof Error) throw first;
    const links = new MarketingLinks({
      database: first.appDatabase,
      adminUserIds: ["admin"],
    });
    expect(await links.initialize()).not.toBeInstanceOf(Error);
    expect(
      await links.create({ ownerUserId: "admin", slug: "launch", tags }),
    ).toMatchObject({ enabled: true });
    expect(await links.resolve("launch")).toEqual(tags);
    expect(
      await links.update({
        ownerUserId: "admin",
        slug: "launch",
        tags,
        enabled: false,
      }),
    ).not.toBeInstanceOf(Error);
    expect(await first.close()).toBeUndefined();
    const reopened = await DatabaseService.start(config);
    if (reopened instanceof Error) throw reopened;
    try {
      const after = new MarketingLinks({
        database: reopened.appDatabase,
        adminUserIds: ["admin"],
      });
      expect(await after.initialize()).not.toBeInstanceOf(Error);
      expect(await after.list("admin")).toEqual([
        { slug: "launch", tags, enabled: false },
      ]);
      expect(await after.resolve("launch")).toBeUndefined();
      expect(await after.resolve("unknown")).toBeUndefined();
      await after.update({
        ownerUserId: "admin",
        slug: "launch",
        tags: { ...tags, utm_content: undefined, utm_term: undefined },
        enabled: true,
      });
      expect(await after.resolve("launch")).toEqual({
        ...tags,
        utm_content: undefined,
        utm_term: undefined,
      });
      expect(
        await after.remove({ ownerUserId: "admin", slug: "launch" }),
      ).toBeUndefined();
      expect(await after.resolve("launch")).toBeUndefined();
      expect(
        await after.create({ ownerUserId: "ordinary", slug: "launch", tags }),
      ).toBeInstanceOf(MarketingAdminRequiredError);
      expect(
        await after.update({
          ownerUserId: "ordinary",
          slug: "launch",
          tags,
          enabled: true,
        }),
      ).toBeInstanceOf(MarketingAdminRequiredError);
      expect(
        await after.remove({ ownerUserId: "ordinary", slug: "launch" }),
      ).toBeInstanceOf(MarketingAdminRequiredError);
    } finally {
      await reopened.close();
    }
    // Closed database errors must not turn into a missing link or successful write.
    const closed = new MarketingLinks({
      database: reopened.appDatabase,
      adminUserIds: ["admin"],
    });
    for (const result of [
      await closed.initialize(),
      await closed.list("admin"),
      await closed.create({ ownerUserId: "admin", slug: "x", tags }),
      await closed.update({
        ownerUserId: "admin",
        slug: "x",
        tags,
        enabled: true,
      }),
      await closed.remove({ ownerUserId: "admin", slug: "x" }),
      await closed.resolve("x"),
    ])
      expect(result).toBeInstanceOf(Error);
  },
);
