import fs from "node:fs/promises";
import path from "node:path";
import { test as baseTest } from "vitest";
import { FilesystemService } from "../filesystem/FilesystemService.js";
import { DatabaseService } from "../database/DatabaseService.js";
import { AutomationService } from "./AutomationService.js";

export const automationTest = baseTest.extend<{
  // Opens a service over the same database, as a restarted server would.
  openAutomations: () => Promise<AutomationService>;
}>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest fixture callbacks require destructured parameters.
  openAutomations: async ({}, use) => {
    const parent = path.resolve(
      import.meta.dirname,
      "../../../../tmp/automations",
    );
    await fs.mkdir(parent, { recursive: true });
    const directory = await fs.mkdtemp(path.join(parent, "service-"));
    const filesystem = new FilesystemService();
    const db = await DatabaseService.open({ directory, filesystem });
    if (db instanceof Error) throw db;
    await use(async () => {
      const automations = await AutomationService.open({
        database: db.createNativeConnection(),
      });
      if (automations instanceof Error) throw automations;
      return automations;
    });
    const databaseClosed = await db.close();
    const filesystemClosed = await filesystem.close();
    await fs.rm(directory, { recursive: true, force: true });
    if (databaseClosed instanceof Error) throw databaseClosed;
    if (filesystemClosed instanceof Error) throw filesystemClosed;
  },
});
