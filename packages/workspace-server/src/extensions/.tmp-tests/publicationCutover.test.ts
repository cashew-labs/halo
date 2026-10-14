import fs from "node:fs/promises";
import path from "node:path";
import util from "node:util";
import childProcess from "node:child_process";
import { expect } from "vitest";
import type { ExtensionArtifact } from "@get-halo/client";
import { serverTest } from "../../../test/serverTest.js";
import { buildBooksArtifact, writeLocalExtension } from "./appFixtures.js";

const appId = "12345678-1234-1234-1234-123456789abc";
const otherApp = "22345678-1234-1234-1234-123456789abc";
const url = "https://michael.gethalo.dev/books/view/";
const cutoverTest = serverTest.extend<{ artifact: ExtensionArtifact }>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
  artifact: async ({}, use) => await use({ ...(await buildBooksArtifact()), data: '{"live":"owner data"}' }),
});
const exists = async (file: string) => await fs.stat(file).then(() => true, () => false);

cutoverTest("publishing freezes the local app, then replaces it with one remote reference", async ({ server, artifact }) => {
  await writeLocalExtension({ workspaceRoot: server.workspaceRoot, id: "books", artifact });
  await server.rpc.extensions.reload();
  expect(await server.rpc.extensions.list()).toMatchObject([{ id: "books", displayName: "Books" }]);

  await expect(server.rpc.extensions.freeze({ id: "missing", appId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(server.rpc.extensions.freeze({ id: "../books", appId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await server.rpc.extensions.freeze({ id: "books", appId });
  // Freezing is idempotent for the same app and exclusive to it.
  await server.rpc.extensions.freeze({ id: "books", appId });
  await expect(server.rpc.extensions.freeze({ id: "books", appId: otherApp })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await server.rpc.extensions.list()).toEqual([]);
  // Neither a snapshot nor a reload restarts a frozen project, so its data cannot change.
  const snapshot = await server.rpc.extensions.snapshot({ id: "books" });
  expect(snapshot.data).toBe('{"live":"owner data"}');
  await server.rpc.extensions.reload();
  expect(await server.rpc.extensions.list()).toEqual([]);
  await expect(server.rpc.extensions.restart({ id: "books" })).rejects.toMatchObject({ code: "BAD_REQUEST" });

  // An aborted publication restores the local app.
  await expect(server.rpc.extensions.release({ id: "books", appId: otherApp })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await server.rpc.extensions.release({ id: "books", appId });
  expect(await server.rpc.extensions.list()).toMatchObject([{ id: "books", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/view\/$/) }]);

  await server.rpc.extensions.freeze({ id: "books", appId });
  await expect(server.rpc.extensions.completePublication({ id: "books", appId: otherApp, url, displayName: "Books" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await server.rpc.extensions.completePublication({ id: "books", appId, url, displayName: "Books" });
  await server.rpc.extensions.completePublication({ id: "books", appId, url, displayName: "Books" });
  expect(await server.rpc.extensions.list()).toEqual([{ id: "books", url, displayName: "Books", remote: { appId } }]);
  // The local copies are retired; only the remote app is maintained.
  expect(await exists(path.join(server.workspaceRoot, ".halo/extensions/books"))).toBe(false);
  expect(await exists(path.join(server.workspaceRoot, ".halo/extension-data/books"))).toBe(false);
  expect(await fs.readFile(path.join(server.workspaceRoot, ".halo/published-backups", appId, "data/tandem.json"), "utf8")).toBe('{"live":"owner data"}');
  await expect(server.rpc.extensions.release({ id: "books", appId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await server.rpc.extensions.reload();
  expect(await server.rpc.extensions.list()).toEqual([{ id: "books", url, displayName: "Books", remote: { appId } }]);
});

cutoverTest("a cutover interrupted after its reference was stored finishes on the next reload", async ({ server, artifact }) => {
  await writeLocalExtension({ workspaceRoot: server.workspaceRoot, id: "books", artifact });
  const marker = path.join(server.workspaceRoot, ".halo/app-publication");
  await fs.mkdir(marker, { recursive: true });
  // The reference was persisted, then the process stopped before retiring copies.
  await fs.writeFile(path.join(marker, "books.json"), JSON.stringify({ state: "remote", appId, url, displayName: "Books" }));
  await server.rpc.extensions.reload();
  expect(await server.rpc.extensions.list()).toEqual([{ id: "books", url, displayName: "Books", remote: { appId } }]);
  expect(await exists(path.join(server.workspaceRoot, ".halo/extensions/books"))).toBe(false);
  expect(await exists(path.join(server.workspaceRoot, ".halo/published-backups", appId, "source/package.json"))).toBe(true);
  // A corrupt state file fails closed instead of starting a second copy.
  await fs.writeFile(path.join(marker, "other.json"), "{");
  await writeLocalExtension({ workspaceRoot: server.workspaceRoot, id: "other", artifact });
  await server.rpc.extensions.reload();
  await expect(server.rpc.extensions.list()).rejects.toBeDefined();
});

cutoverTest("blocked or corrupt publication state fails closed and never starts a second copy", async ({ server, artifact }) => {
  await writeLocalExtension({ workspaceRoot: server.workspaceRoot, id: "books", artifact });
  await server.rpc.extensions.reload();
  // A local-only workspace has no account to publish to.
  await expect(server.rpc.apps.list()).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Published apps need a Halo account workspace" });
  // The state directory cannot be created: freezing fails and the app keeps running.
  await fs.chmod(path.join(server.workspaceRoot, ".halo"), 0o555);
  await expect(server.rpc.extensions.freeze({ id: "books", appId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await fs.chmod(path.join(server.workspaceRoot, ".halo"), 0o755);
  expect(await server.rpc.extensions.list()).toMatchObject([{ id: "books" }]);
  // Backups cannot be created: the reference stays, and reload retries later.
  await server.rpc.extensions.freeze({ id: "books", appId });
  await fs.writeFile(path.join(server.workspaceRoot, ".halo/published-backups"), "not a directory");
  await expect(server.rpc.extensions.completePublication({ id: "books", appId, url, displayName: "Books" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await server.rpc.extensions.reload();
  expect(await server.rpc.extensions.list()).toEqual([{ id: "books", url, displayName: "Books", remote: { appId } }]);
  await fs.rm(path.join(server.workspaceRoot, ".halo/published-backups"));
  await server.rpc.extensions.reload();
  expect(await exists(path.join(server.workspaceRoot, ".halo/extensions/books"))).toBe(false);
  // A marker with the wrong shape is rejected.
  await fs.writeFile(path.join(server.workspaceRoot, ".halo/app-publication/books.json"), JSON.stringify({ state: "remote", appId: "not-an-id" }));
  await expect(server.rpc.extensions.list()).rejects.toBeDefined();
});

cutoverTest("an extension that crashed before publishing still freezes and releases", async ({ server, artifact }) => {
  await writeLocalExtension({ workspaceRoot: server.workspaceRoot, id: "books", artifact });
  await server.rpc.extensions.reload();
  const dataDirectory = path.join(server.workspaceRoot, ".halo/extension-data/books");
  const { stdout } = await util.promisify(childProcess.execFile)("pgrep", ["-f", "--", `--data-dir ${dataDirectory}`]);
  for (const pid of stdout.trim().split("\n")) process.kill(Number(pid), "SIGKILL");
  await expect.poll(async () => await util.promisify(childProcess.execFile)("pgrep", ["-f", "--", `--data-dir ${dataDirectory}`]).then(() => true, () => false)).toBe(false);
  // The crashed process stops with an error; the freeze still succeeds.
  await server.rpc.extensions.freeze({ id: "books", appId });
  expect(await server.rpc.extensions.list()).toEqual([]);
  await server.rpc.extensions.release({ id: "books", appId });
  expect(await server.rpc.extensions.list()).toMatchObject([{ id: "books" }]);
});
