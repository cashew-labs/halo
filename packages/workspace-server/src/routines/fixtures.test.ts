import fs from "node:fs/promises";
import path from "node:path";
import { test as baseTest } from "vitest";
import { FilesystemService } from "../filesystem/FilesystemService.js";
import { DatabaseService } from "../database/DatabaseService.js";
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
    const database = await DatabaseService.open({ directory, filesystem });
    if (database instanceof Error) throw database;
    await use(async () => {
      return new RoutineService({ database });
    });
    const databaseClosed = await database.close();
    const filesystemClosed = await filesystem.close();
    await fs.rm(directory, { recursive: true, force: true });
    if (databaseClosed instanceof Error) throw databaseClosed;
    if (filesystemClosed instanceof Error) throw filesystemClosed;
  },
});
