import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { expect } from "vitest";
import * as errore from "errore";
import { serverTest } from "../serverTest.js";

serverTest(
  "remote deletion preserves unrelated local projects and refuses wrong or frozen references",
  async ({ server }) => {
    const appId = crypto.randomUUID();
    const otherAppId = crypto.randomUUID();
    const id = "keep-local";
    const source = path.join(server.workspaceRoot, ".halo/extensions", id);
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "keep.txt"), "local source");
    // An absent marker is an idempotent retry, never permission to remove a local project.
    await server.rpc.extensions.deletePublication({ id, appId });
    expect(await fs.readFile(path.join(source, "keep.txt"), "utf8")).toBe(
      "local source",
    );
    await server.rpc.extensions.freeze({ id, appId });
    await expect(
      server.rpc.extensions.deletePublication({ id, appId }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await server.rpc.extensions.completePublication({
      id,
      appId,
      url: "https://example.test/app/",
      displayName: "Keep local",
    });
    await expect(
      server.rpc.extensions.deletePublication({ id, appId: otherAppId }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await server.rpc.extensions.list()).toMatchObject([
      { id, remote: { appId } },
    ]);
    // Simulate an interrupted cutover with remaining source and data.
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "remaining.txt"), "source");
    const data = path.join(server.workspaceRoot, ".halo/extension-data", id);
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(path.join(data, "data.txt"), "data");
    // Remove the old backup to model marker persistence before the first rename.
    await fs.rm(
      path.join(server.workspaceRoot, ".halo/published-backups", appId),
      { recursive: true },
    );
    await server.rpc.extensions.deletePublication({ id, appId });
    expect(await server.rpc.extensions.list()).toEqual([]);
    await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(data)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(
        path.join(server.workspaceRoot, ".halo/published-backups", appId),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await server.rpc.extensions.deletePublication({ id, appId });
    for (const input of [
      { id: "../escape", appId },
      { id, appId: "../escape" },
    ]) {
      await expect(
        server.rpc.extensions.deletePublication(input),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  },
);

serverTest(
  "app VMs cannot delete owner workspace references",
  async ({ createServer }) => {
    const appId = crypto.randomUUID();
    const server = createServer({
      sharedApp: { appId, extensionId: "shared", syncAccess: "read-only" },
    });
    await server.start();
    await expect(
      server.rpc.extensions.deletePublication({ id: "shared", appId }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  },
);

serverTest(
  "failed backup cleanup keeps the remote reference for retry",
  async ({ server }) => {
    const id = "retry-cleanup";
    const appId = crypto.randomUUID();
    await server.rpc.extensions.addRemote({
      id,
      appId,
      url: "https://example.test/app/",
      displayName: id,
    });
    const backups = path.join(server.workspaceRoot, ".halo/published-backups");
    await fs.writeFile(backups, "not a directory");
    await expect(
      server.rpc.extensions.deletePublication({ id, appId }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await server.rpc.extensions.list()).toMatchObject([
      { id, remote: { appId } },
    ]);
    await fs.rm(backups);
    await server.rpc.extensions.deletePublication({ id, appId });
    expect(await server.rpc.extensions.list()).toEqual([]);
  },
);

serverTest(
  "filesystem cleanup failures keep a matching reference until retry",
  async ({ server }) => {
    const id = "permission-retry";
    const appId = crypto.randomUUID();
    const backup = path.join(
      server.workspaceRoot,
      ".halo/published-backups",
      appId,
    );
    const markerDirectory = path.join(
      server.workspaceRoot,
      ".halo/app-publication",
    );
    const locked = path.join(backup, "locked");
    await server.rpc.extensions.addRemote({
      id,
      appId,
      url: "https://example.test/app/",
      displayName: id,
    });
    await fs.mkdir(locked, { recursive: true });
    await fs.writeFile(path.join(locked, "private.txt"), "private data");
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      await fs.chmod(markerDirectory, 0o700);
    });
    cleanup.defer(async () => {
      await fs.chmod(locked, 0o700).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== "ENOENT") throw cause;
      });
    });
    await fs.chmod(locked, 0o000);
    await expect(
      server.rpc.extensions.deletePublication({ id, appId }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("delete backup"),
    });
    await fs.chmod(locked, 0o700);
    await fs.chmod(markerDirectory, 0o555);
    await expect(
      server.rpc.extensions.deletePublication({ id, appId }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("delete reference"),
    });
    expect(await server.rpc.extensions.list()).toMatchObject([
      { id, remote: { appId } },
    ]);
    await fs.chmod(markerDirectory, 0o700);
    await server.rpc.extensions.deletePublication({ id, appId });
    expect(await server.rpc.extensions.list()).toEqual([]);
  },
);
