import fs from "node:fs/promises";
import path from "node:path";
import type { Storage } from "@earendil-works/pi-durable";
import { test as baseTest } from "vitest";
import { FilesystemService } from "../filesystem/FilesystemService.js";
import { DatabaseClient } from "./DatabaseClient.js";
import { TursoThreadRepo } from "./TursoThreadRepo.js";

type PiBackendFixture = {
  repo: TursoThreadRepo;
  openStorage(): Promise<Storage>;
};

export const piBackendTest = baseTest.extend<{
  piBackend: PiBackendFixture;
}>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest fixture callbacks require destructured parameters.
  piBackend: async ({}, use) => {
    const parent = path.resolve(
      import.meta.dirname,
      "../../../../tmp/piBackend",
    );
    await fs.mkdir(parent, { recursive: true });
    const directory = await fs.mkdtemp(path.join(parent, "conformance-"));
    const filesystem = new FilesystemService();
    const database = await DatabaseClient.open({
      directory,
      filesystem,
    });
    if (database instanceof Error) throw database;
    const repo = new TursoThreadRepo(database);

    await use({
      repo,
      async openStorage() {
        return (await repo.create()).storage;
      },
    });

    const repoClosed = await repo.close();
    const databaseClosed = await database.close();
    const filesystemClosed = await filesystem.close();
    await fs.rm(directory, { recursive: true, force: true });
    if (repoClosed instanceof Error) throw repoClosed;
    if (databaseClosed instanceof Error) throw databaseClosed;
    if (filesystemClosed instanceof Error) throw filesystemClosed;
  },
});
