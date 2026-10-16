import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import events from "node:events";
import { expect } from "vitest";
import { createHaloClient, type AppSummary } from "@get-halo/client";
import type { AddressInfo } from "node:net";
import * as errore from "errore";
import { serverTest } from "../serverTest.js";

const buildId = "39ac4a1e-df81-492f-8f77-80a39e001cc6";
const launcher = `import http from "node:http"; const server = http.createServer((_req, res) => res.end("local extension")); server.listen(0, "127.0.0.1", () => process.send("http://127.0.0.1:" + server.address().port + "/view/")); process.on("message", (message) => { if (message === "shutdown") server.close(() => process.exit(0)); });`;
const artifact = {
  files: {
    "package.json": JSON.stringify({
      name: "example",
      halo: { displayName: "Example" },
    }),
    "source.txt": "latest source",
  },
  assets: {},
  build: {
    "dist/start.mjs": Buffer.from(launcher).toString("base64"),
    "dist/current.json": Buffer.from(JSON.stringify(buildId)).toString(
      "base64",
    ),
    [`dist/${buildId}/server.mjs`]: Buffer.from(launcher).toString("base64"),
  },
  data: "latest data",
};

serverTest(
  "app removal restores source and data; extension deletion is a separate operation",
  async ({ server }) => {
    const appId = crypto.randomUUID();
    const id = "example";
    await server.rpc.extensions.addRemote({
      id,
      appId,
      displayName: "Example",
      url: "https://example.test/view/",
    });
    expect(await server.rpc.extensions.prepareAppRemoval({ id, appId })).toBe(
      false,
    );
    await expect(server.rpc.extensions.delete({ id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      server.rpc.extensions.completeAppRemoval({ id, appId }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      server.rpc.extensions.prepareAppRemoval({
        id,
        appId: crypto.randomUUID(),
        artifact,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(
      await server.rpc.extensions.prepareAppRemoval({ id, appId, artifact }),
    ).toBe(true);
    expect(await server.rpc.extensions.prepareAppRemoval({ id, appId })).toBe(
      true,
    );
    const source = path.join(server.workspaceRoot, ".halo/extensions", id);
    await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
    await server.rpc.extensions.completeAppRemoval({ id, appId });
    expect(await server.rpc.extensions.list()).toEqual([]);
    expect(await fs.readFile(path.join(source, "source.txt"), "utf8")).toBe(
      "latest source",
    );
    expect(
      await fs.readFile(
        path.join(
          server.workspaceRoot,
          ".halo/extension-data",
          id,
          "tandem.json",
        ),
        "utf8",
      ),
    ).toBe("latest data");
    await server.rpc.extensions.completeAppRemoval({ id, appId });
    await server.rpc.extensions.delete({ id });
    expect(await server.rpc.extensions.list()).toEqual([]);
    await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
    await server.rpc.extensions.delete({ id });
    for (const input of [
      { id: "../escape", appId },
      { id, appId: "../escape" },
    ]) {
      await expect(
        server.rpc.extensions.prepareAppRemoval(input),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        server.rpc.extensions.completeAppRemoval(input),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    await expect(
      server.rpc.extensions.delete({ id: "../escape" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      server.rpc.extensions.snapshotForRemoval({ id, appId }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  },
);

serverTest(
  "a hosted removal snapshot stays frozen across reloads and host restarts",
  async ({ createServer }) => {
    const appId = crypto.randomUUID();
    const id = "example";
    const server = createServer({
      sharedApp: { appId, extensionId: id, syncAccess: "read-only" },
    });
    const source = path.join(server.workspaceRoot, ".halo/extensions", id);
    for (const [name, contents] of [
      ...Object.entries(artifact.files).map(
        ([name, text]) => [name, Buffer.from(text)] as const,
      ),
      ...Object.entries(artifact.build).map(
        ([name, encoded]) => [name, Buffer.from(encoded, "base64")] as const,
      ),
    ]) {
      await fs.mkdir(path.dirname(path.join(source, name)), {
        recursive: true,
      });
      await fs.writeFile(path.join(source, name), contents);
    }
    const data = path.join(server.workspaceRoot, ".halo/extension-data", id);
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(path.join(data, "tandem.json"), "latest data");
    await server.start();
    await expect(
      server.rpc.extensions.snapshotForRemoval({
        id,
        appId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const snapshot = await server.rpc.extensions.snapshotForRemoval({
      id,
      appId,
    });
    expect(snapshot).toMatchObject({
      files: { "source.txt": "latest source" },
      data: "latest data",
    });
    await server.rpc.extensions.reload();
    expect(await server.rpc.extensions.list()).toMatchObject([
      { id, publishing: { appId } },
    ]);
    await server.stop();
    await server.start();
    expect(
      await server.rpc.extensions.snapshotForRemoval({ id, appId }),
    ).toEqual(snapshot);
    await expect(server.rpc.extensions.delete({ id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      server.rpc.extensions.prepareAppRemoval({ id, appId, artifact }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      server.rpc.extensions.completeAppRemoval({ id, appId }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  },
);

serverTest(
  "local extension deletion removes only its own files and data",
  async ({ server }) => {
    const id = "local";
    for (const directory of ["extensions", "extension-data"]) {
      for (const extensionId of [id, "other"]) {
        const target = path.join(
          server.workspaceRoot,
          ".halo",
          directory,
          extensionId,
        );
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, "keep.txt"), extensionId);
      }
    }
    await server.rpc.extensions.delete({ id });
    for (const directory of ["extensions", "extension-data"]) {
      await expect(
        fs.stat(path.join(server.workspaceRoot, ".halo", directory, id)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        await fs.readFile(
          path.join(server.workspaceRoot, ".halo", directory, "other/keep.txt"),
          "utf8",
        ),
      ).toBe("other");
    }
  },
);

serverTest(
  "filesystem failures preserve progress for separate removal and deletion retries",
  async ({ server }) => {
    const id = "example";
    const appId = crypto.randomUUID();
    await server.rpc.extensions.addRemote({
      id,
      appId,
      url: "https://example.test/view/",
      displayName: id,
    });
    await server.rpc.extensions.prepareAppRemoval({ id, appId, artifact });
    const markers = path.join(server.workspaceRoot, ".halo/app-publication");
    const backup = path.join(
      server.workspaceRoot,
      ".halo/published-backups",
      appId,
      "locked",
    );
    await fs.mkdir(backup, { recursive: true });
    await fs.writeFile(path.join(backup, "old.txt"), "original backup");
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      await fs.chmod(markers, 0o700);
    });
    cleanup.defer(async () => {
      await fs.chmod(backup, 0o700).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== "ENOENT") throw cause;
      });
    });
    await fs.chmod(markers, 0o555);
    await expect(
      server.rpc.extensions.completeAppRemoval({ id, appId }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("remove app reference"),
    });
    await fs.chmod(markers, 0o700);
    await server.rpc.extensions.completeAppRemoval({ id, appId });
    await fs.chmod(backup, 0o000);
    await expect(server.rpc.extensions.delete({ id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("delete local extension files"),
    });
    await fs.chmod(backup, 0o700);
    await server.rpc.extensions.delete({ id });
    expect(await server.rpc.extensions.list()).toEqual([]);
  },
);

serverTest("extension deletion cleans backups across repeated publication cycles", async ({ server }) => {
  const id = "example";
  const firstAppId = crypto.randomUUID();
  const secondAppId = crypto.randomUUID();
  await server.rpc.extensions.addRemote({ id, appId: firstAppId, url: "https://example.test/view/", displayName: id });
  await server.rpc.extensions.prepareAppRemoval({ id, appId: firstAppId, artifact });
  await server.rpc.extensions.completeAppRemoval({ id, appId: firstAppId });
  const firstBackup = path.join(server.workspaceRoot, ".halo/published-backups", firstAppId, "source");
  await fs.mkdir(firstBackup, { recursive: true });
  await fs.writeFile(path.join(firstBackup, "original.txt"), "original source");
  await server.rpc.extensions.freeze({ id, appId: secondAppId });
  await server.rpc.extensions.completePublication({ id, appId: secondAppId, url: "https://example.test/view/", displayName: id });
  await server.rpc.extensions.prepareAppRemoval({ id, appId: secondAppId, artifact });
  await server.rpc.extensions.completeAppRemoval({ id, appId: secondAppId });
  await server.rpc.extensions.delete({ id });
  for (const appId of [firstAppId, secondAppId]) {
    for (const directory of ["published-backups", "app-removals"]) {
      await expect(fs.stat(path.join(server.workspaceRoot, ".halo", directory, appId))).rejects.toMatchObject({ code: "ENOENT" });
    }
  }
});


const sandboxTest = serverTest.extend<{ sandbox: { socketPath: string; stopFails: boolean; snapshotFails: boolean } }>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
  sandbox: async ({}, use) => {
    const parent = path.resolve(import.meta.dirname, "../../../../tmp/published-app-deletion");
    await fs.mkdir(parent, { recursive: true });
    const state = { socketPath: path.join(parent, `s-${crypto.randomUUID().slice(0, 6)}`), stopFails: false, snapshotFails: false };
    const supervisor = http.createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if ((request.url === "/stop" && state.stopFails) || (request.url === "/snapshot" && state.snapshotFails)) {
        response.writeHead(503).end(JSON.stringify({ error: "supervisor unavailable" }));
        return;
      }
      const payload = request.url === "/start" ? { url: "http://127.0.0.1:12345/view/" } : request.url === "/stop" ? { stopped: true } : request.url === "/snapshot" ? { data: "sandbox data" } : { running: false };
      response.end(JSON.stringify(payload));
    });
    supervisor.listen(state.socketPath);
    await events.once(supervisor, "listening");
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => { supervisor.closeAllConnections(); await new Promise<void>((complete, reject) => supervisor.close((error) => error === undefined ? complete() : reject(error))); });
    await use(state);
  },
});

sandboxTest("removal freezes the sandbox and rejects later source changes", async ({ sandbox, createServer }) => {
  const appId = crypto.randomUUID();
  const id = "example";
  const server = createServer({ sharedApp: { appId, extensionId: id, syncAccess: "read-only" }, extensionRuntime: { executable: process.execPath, electronRunAsNode: false, sandbox: { socketPath: sandbox.socketPath } } });
  await server.start();
  await server.rpc.extensions.install({ id, artifact, installId: crypto.randomUUID() });
  sandbox.stopFails = true;
  await expect(server.rpc.extensions.snapshotForRemoval({ id, appId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  sandbox.stopFails = false;
  sandbox.snapshotFails = true;
  await expect(server.rpc.extensions.snapshotForRemoval({ id, appId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  sandbox.snapshotFails = false;
  expect(await server.rpc.extensions.snapshotForRemoval({ id, appId })).toMatchObject({ data: "sandbox data" });
  await expect(server.rpc.extensions.writeSource({ id, name: "source.txt", contents: "late change" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("removal has started") });
  await expect(server.rpc.extensions.execSource({ id, command: "echo late change" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("removal has started") });
  await expect(server.rpc.extensions.install({ id, artifact, installId: crypto.randomUUID() })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("removal has started") });
  await server.rpc.extensions.reload();
  expect(await server.rpc.extensions.readSource({ id, name: "source.txt" })).toBe("latest source");
});


serverTest("malformed removal receipts cannot discard source or an unrelated publication", async ({ server }) => {
  const id = "example";
  const appId = crypto.randomUUID();
  await server.rpc.extensions.addRemote({ id, appId, url: "https://example.test/view/", displayName: id });
  await expect(server.rpc.extensions.completeAppRemoval({ id, appId: crypto.randomUUID() })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await server.rpc.extensions.prepareAppRemoval({ id, appId, artifact });
  const root = path.join(server.workspaceRoot, ".halo/app-removals", appId);
  const ready = path.join(root, "ready");
  await fs.writeFile(ready, "not prepared");
  await using cleanup = new errore.AsyncDisposableStack();
  cleanup.defer(async () => { await fs.chmod(ready, 0o600).catch((cause: NodeJS.ErrnoException) => { if (cause.code !== "ENOENT") throw cause; }); });
  await fs.chmod(ready, 0o400);
  await expect(server.rpc.extensions.prepareAppRemoval({ id, appId, artifact })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("save removal progress") });
  await fs.chmod(ready, 0o600);
  await server.rpc.extensions.prepareAppRemoval({ id, appId, artifact });
  const sourceParent = path.join(server.workspaceRoot, ".halo/extensions");
  await fs.rm(sourceParent, { recursive: true, force: true });
  await fs.writeFile(sourceParent, "not a directory");
  await expect(server.rpc.extensions.completeAppRemoval({ id, appId })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("create local extension directory") });
  await fs.rm(sourceParent);
  await fs.rm(path.join(root, ".halo/extensions", id), { recursive: true });
  await expect(server.rpc.extensions.completeAppRemoval({ id, appId })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("saved extension is missing") });
});

serverTest("invalid or cyclic backup identities cannot delete other files", async ({ server }) => {
  const id = "example";
  const appId = crypto.randomUUID();
  await server.rpc.extensions.addRemote({ id, appId, url: "https://example.test/view/", displayName: id });
  await server.rpc.extensions.prepareAppRemoval({ id, appId, artifact });
  await server.rpc.extensions.completeAppRemoval({ id, appId });
  const marker = path.join(server.workspaceRoot, ".halo/extensions", id, ".install-id");
  await fs.writeFile(marker, "../bad identity");
  await expect(server.rpc.extensions.delete({ id })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("invalid local app identity") });
  await fs.rm(marker);
  await fs.mkdir(marker);
  await expect(server.rpc.extensions.delete({ id })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("read local app identity") });
  await fs.rm(marker, { recursive: true });
  await fs.writeFile(marker, appId);
  const old = path.join(server.workspaceRoot, ".halo/published-backups", appId, "source");
  await fs.mkdir(old, { recursive: true });
  await fs.writeFile(path.join(old, ".install-id"), appId);
  await expect(server.rpc.extensions.delete({ id })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("cycle") });
  await fs.rm(path.join(old, ".install-id"));
  await server.rpc.extensions.delete({ id });
});

const bridgeTest = serverTest.extend<{ bridge: { origin: string; apps: AppSummary[]; unavailable: boolean } }>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
  bridge: async ({}, use) => {
    const state = { origin: "", apps: [] as AppSummary[], unavailable: false };
    const upstream = http.createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      if (state.unavailable) { response.writeHead(503).end('{"json":{}}'); return; }
      response.end(JSON.stringify({ json: state.apps }));
    });
    upstream.listen(0, "127.0.0.1");
    await events.once(upstream, "listening");
    state.origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => { upstream.closeAllConnections(); await new Promise<void>((complete, reject) => upstream.close((error) => error === undefined ? complete() : reject(error))); });
    await use(state);
  },
});

bridgeTest("extension delete waits for app removal to finish and reports connection failures", async ({ bridge, createServer }) => {
  const id = "example";
  const appId = crypto.randomUUID();
  bridge.apps = [{ appId, extensionId: id, handle: "owner", slug: id, url: "https://example.test/", displayName: id, published: false, stage: "removing", visibility: "public", members: [], actions: [] }];
  const server = createServer({ remoteApps: createHaloClient({ transport: { origin: bridge.origin, path: "/rpc" } }).apps });
  await server.start();
  await server.rpc.extensions.addRemote({ id, appId, displayName: id, url: "https://example.test/view/" });
  await server.rpc.extensions.prepareAppRemoval({ id, appId, artifact });
  await server.rpc.extensions.completeAppRemoval({ id, appId });
  await expect(server.rpc.extensions.delete({ id })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("to finish") });
  bridge.unavailable = true;
  await expect(server.rpc.extensions.delete({ id })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("check app removal") });
  bridge.unavailable = false;
  bridge.apps = [];
  await server.rpc.extensions.delete({ id });
  expect(await server.rpc.extensions.list()).toEqual([]);
});

serverTest("a partial template-app restore survives reload and workspace restart", async ({ server }) => {
  const id = "example";
  const appId = crypto.randomUUID();
  await server.rpc.extensions.addRemote({ id, appId, url: "https://example.test/view/", displayName: id });
  await server.rpc.extensions.prepareAppRemoval({ id, appId, artifact });
  const markers = path.join(server.workspaceRoot, ".halo/app-publication");
  await using cleanup = new errore.AsyncDisposableStack();
  cleanup.defer(async () => { await fs.chmod(markers, 0o700); });
  await fs.chmod(markers, 0o555);
  await expect(server.rpc.extensions.completeAppRemoval({ id, appId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await fs.chmod(markers, 0o700);
  // Template copies have no original publication backup to prevent a mistaken retirement.
  await server.rpc.extensions.reload();
  await server.stop();
  await server.start();
  await server.rpc.extensions.completeAppRemoval({ id, appId });
  expect(await fs.readFile(path.join(server.workspaceRoot, ".halo/extensions", id, "source.txt"), "utf8")).toBe("latest source");
  expect(await fs.readFile(path.join(server.workspaceRoot, ".halo/extension-data", id, "tandem.json"), "utf8")).toBe("latest data");
});
