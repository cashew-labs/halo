import fs from "node:fs/promises";
import path from "node:path";
import type { StorageFixture } from "@earendil-works/pi-agent-core/harness/session/testing";
import { test as baseTest } from "vitest";
import { FilesystemService } from "../filesystem/FilesystemService.js";
import { DatabaseClient } from "./DatabaseClient.js";
import { TursoSessionRepo } from "./TursoSessionRepo.js";
import { TursoStorage } from "./TursoStorage.js";

export type PiBackendFixture = {
  repo: TursoSessionRepo;
  openStorage(): Promise<StorageFixture>;
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
    const repo = new TursoSessionRepo(database);

    await use({
      repo,
      async openStorage() {
        const session = await repo.create(undefined);
        const storage = new TursoStorage(database, session.metadata.id);
        return {
          storage,
          [Symbol.asyncDispose]: async () => await storage.close(),
        };
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
