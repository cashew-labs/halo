import fs from "node:fs/promises";
import path from "node:path";
import { describe, onTestFinished, test } from "vitest";
import {
  createStorageConformance,
  createSessionRepoConformance,
} from "@earendil-works/pi-agent-core/harness/session/testing";
import { DatabaseClient } from "../src/storage/DatabaseClient.js";
import { TursoSessionRepo } from "../src/storage/TursoSessionRepo.js";
import { TursoStorage } from "../src/storage/TursoStorage.js";
import { FilesystemService } from "../src/filesystem/FilesystemService.js";

async function openBackend() {
  const parent = path.resolve(import.meta.dirname, "../../../tmp/tursoStorage");
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, "conformance-"));
  const filesystem = new FilesystemService();
  const database = await DatabaseClient.open({ directory, filesystem });
  if (database instanceof Error) throw database;
  const repo = await TursoSessionRepo.open(database);
  if (repo instanceof Error) throw repo;
  onTestFinished(async () => {
    const closed = await repo.close();
    const databaseClosed = await database.close();
    await filesystem.close();
    await fs.rm(directory, { recursive: true, force: true });
    if (closed instanceof Error) throw closed;
    if (databaseClosed instanceof Error) throw databaseClosed;
  });
  return { repo, database };
}

describe("Pi Storage conformance", () => {
  for (const scenario of createStorageConformance(async () => {
    const { repo, database } = await openBackend();
    const session = await repo.create(undefined);
    const storage = new TursoStorage(database, session.metadata.id);
    return {
      storage,
      [Symbol.asyncDispose]: async () => await storage.close(),
    };
  })) {
    test(`${scenario.group}: ${scenario.name}`, scenario.run);
  }
});

describe("Pi SessionRepo conformance", () => {
  for (const scenario of createSessionRepoConformance(
    async () => (await openBackend()).repo,
  )) {
    test(`${scenario.group}: ${scenario.name}`, scenario.run);
  }
});
