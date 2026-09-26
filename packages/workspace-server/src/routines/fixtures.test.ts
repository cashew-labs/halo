import fs from "node:fs/promises";
import path from "node:path";
import { test as baseTest } from "vitest";
import { FilesystemService } from "../filesystem/FilesystemService.js";
import { DatabaseClient } from "../storage/DatabaseClient.js";
import { RoutineService } from "./RoutineService.js";

export const routineTest = baseTest.extend<{
  // Opens a service over the same database, as a restarted server would.
  openRoutines: () => Promise<RoutineService>;
}>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest fixture callbacks require destructured parameters.
  openRoutines: async ({}, use) => {
    const parent = path.resolve(
      import.meta.dirname,
      "../../../../tmp/routines",
    );
    await fs.mkdir(parent, { recursive: true });
    const directory = await fs.mkdtemp(path.join(parent, "service-"));
    const filesystem = new FilesystemService();
    const database = await DatabaseClient.open({ directory, filesystem });
    if (database instanceof Error) throw database;
    await use(async () => {
      const routines = await RoutineService.open({ database });
      if (routines instanceof Error) throw routines;
      return routines;
    });
    const databaseClosed = await database.close();
    const filesystemClosed = await filesystem.close();
    await fs.rm(directory, { recursive: true, force: true });
    if (databaseClosed instanceof Error) throw databaseClosed;
    if (filesystemClosed instanceof Error) throw filesystemClosed;
  },
});
