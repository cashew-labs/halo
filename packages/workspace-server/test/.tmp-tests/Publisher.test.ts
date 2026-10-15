import { expect } from "vitest";
import { serverTest } from "../serverTest.js";
import type { WorkspaceServerOptions } from "@get-halo/workspace-server";

serverTest(
  "owner workspace forwards publishing operations and refreshes remote extension links",
  async ({ createServer }) => {
    let handle = "old";
    let offline = false;
    let missing = false;
    let slow: Promise<void> | undefined;
    // The external control-plane transport is simulated; the workspace server,
    // extension persistence, RPC and subscription are real.
    const remoteApps = {
      publisher: async () => ({
        handle,
        origin: `https://${handle}.gethalo.dev`,
      }),
      checkPublisherHandle: async () => ({ available: true }),
      renamePublisher: async (input: { handle: string }) => {
        handle = input.handle;
        return { handle, origin: `https://${handle}.gethalo.dev` };
      },
      list: async () => {
        await slow;
        if (offline) throw new Error("Control plane offline");
        return missing
          ? []
          : [
              {
                appId: "11111111-1111-4111-8111-111111111111",
                url: `https://${handle}.gethalo.dev/notes/`,
              },
            ];
      },
    } as WorkspaceServerOptions["host"]["remoteApps"];
    const server = createServer({ remoteApps });
    await server.start();
    expect((await server.rpc.apps.publisher()).handle).toBe("old");
    expect(
      await server.rpc.apps.checkPublisherHandle({ handle: "new" }),
    ).toEqual({ available: true });
    await server.rpc.extensions.addRemote({
      id: "notes",
      appId: "11111111-1111-4111-8111-111111111111",
      url: "https://stale.gethalo.dev/notes/view/",
      displayName: "Notes",
    });
    // The current link's refresh lands in the background.
    await expect
      .poll(async () => (await server.rpc.extensions.list())[0]?.url)
      .toBe("https://old.gethalo.dev/notes/view/");
    const abort = new AbortController();
    const snapshots = await server.rpc.extensions.watch(undefined, {
      signal: abort.signal,
    });
    const iterator = snapshots[Symbol.asyncIterator]();
    await iterator.next();
    expect(
      (await server.rpc.apps.renamePublisher({ handle: "new" })).handle,
    ).toBe("new");
    expect((await iterator.next()).value).toMatchObject([
      { url: "https://new.gethalo.dev/notes/view/" },
    ]);
    abort.abort();
    expect(await server.rpc.extensions.list()).toMatchObject([
      { url: "https://new.gethalo.dev/notes/view/" },
    ]);
    offline = true;
    // While the control plane is unreachable the sidebar keeps the last link it knew.
    expect(await server.rpc.extensions.list()).toMatchObject([
      { url: "https://new.gethalo.dev/notes/view/" },
    ]);
    expect(
      (await server.rpc.apps.renamePublisher({ handle: "offline-renamed" }))
        .handle,
    ).toBe("offline-renamed");
    offline = false;
    // A slow link lookup never holds the extension queue.
    let resume = () => {};
    slow = new Promise<void>((resolve) => { resume = resolve; });
    const started = Date.now();
    const listing = server.rpc.extensions.list();
    await server.rpc.extensions.reload();
    // The list answers from known links without waiting for the lookup.
    expect(await listing).toMatchObject([{ id: "notes" }]);
    expect(Date.now() - started).toBeLessThan(1_000);
    resume();
    slow = undefined;
    missing = true;
    expect(await server.rpc.extensions.list()).toMatchObject([{ id: "notes" }]);
    const brokenWatch = await server.rpc.extensions.watch();
    const brokenIterator = brokenWatch[Symbol.asyncIterator]();
    await brokenIterator.next();
    await server.harness.files.write({
      path: `${server.workspaceRoot}/.halo/app-publication/notes.json`,
      content: "broken publication state",
    });
    expect(
      (
        await server.rpc.apps.renamePublisher({
          handle: "saved-despite-local-error",
        })
      ).handle,
    ).toBe("saved-despite-local-error");
    await expect(brokenIterator.next()).rejects.toThrow(
      "App publication failed",
    );
  },
);

serverTest(
  "local-only workspace cannot access publishing settings",
  async ({ server }) => {
    await expect(server.rpc.apps.publisher()).rejects.toThrow(
      "Published apps need a Halo account workspace",
    );
  },
);

serverTest(
  "a slower lookup that started first cannot replace a newer link",
  async ({ createServer }) => {
    let calls = 0;
    let firstReturned = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const remoteApps = {
      publisher: async () => ({ handle: "new", origin: "https://new.gethalo.dev" }),
      checkPublisherHandle: async () => ({ available: true }),
      renamePublisher: async () => ({ handle: "new", origin: "https://new.gethalo.dev" }),
      list: async () => {
        calls += 1;
        if (calls === 1) {
          await gate;
          firstReturned = true;
          return [{ appId: "11111111-1111-4111-8111-111111111111", url: "https://old.gethalo.dev/notes/" }];
        }
        return [{ appId: "11111111-1111-4111-8111-111111111111", url: "https://new.gethalo.dev/notes/" }];
      },
    } as WorkspaceServerOptions["host"]["remoteApps"];
    const server = createServer({ remoteApps });
    await server.start();
    await server.rpc.extensions.addRemote({ id: "notes", appId: "11111111-1111-4111-8111-111111111111", url: "https://stored.gethalo.dev/notes/view/", displayName: "Notes" });
    // The first lookup starts and stalls; the rename's lookup finishes first.
    await server.rpc.extensions.list();
    await server.rpc.apps.renamePublisher({ handle: "new" });
    expect(await server.rpc.extensions.list()).toMatchObject([{ url: "https://new.gethalo.dev/notes/view/" }]);
    release();
    await expect.poll(() => firstReturned).toBe(true);
    // Let the overtaken lookup's result settle before reading the links again.
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(await server.rpc.extensions.list()).toMatchObject([{ url: "https://new.gethalo.dev/notes/view/" }]);
  },
);
