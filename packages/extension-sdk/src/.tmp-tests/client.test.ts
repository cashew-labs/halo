import { test as baseTest, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import * as errore from "errore";
import { connectExtension } from "../client.js";
import { serveExtension } from "../server.js";
import { os } from "../api.js";
import { collection, defineSchema, t } from "../schema.js";

const schema = defineSchema({
  items: collection({ id: t.id(), label: t.string() }),
});
const clientTest = baseTest.extend<{
  start(options: {
    hostToken?: string;
    syncAccess?: "actions";
  }): Promise<string>;
}>({
  start: async ({}, use) => {
    const root = await fs.mkdtemp(
      path.resolve(import.meta.dirname, "../../../../tmp/loading-speed/sdk-"),
    );
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(
      async () => await fs.rm(root, { recursive: true, force: true }),
    );
    cleanup.defer(() => vi.unstubAllGlobals());
    cleanup.defer(() => vi.restoreAllMocks());
    await use(async (options) => {
      const running = await serveExtension({
        ...options,
        router: { title: os.handler(() => "Ready") },
        schema,
        relations: {},
        publicDirectory: root,
        dataDirectory: root,
        port: 0,
      });
      if (running instanceof Error) throw running;
      cleanup.defer(async () => {
        const closed = await running.close();
        if (closed instanceof Error) throw closed;
      });
      vi.stubGlobal("location", new URL(running.url));
      return running.url;
    });
  },
});

clientTest(
  "returns the local view client and reports a failed background connection",
  async ({ start }) => {
    await start({ hostToken: "unavailable-to-this-client" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connectExtension({ schema, relations: {} });
    expect(client).not.toBeInstanceOf(Error);
    if (client instanceof Error) throw client;
    expect(client.storage.query({ collection: "items" })).toEqual([]);
    expect(await client.connected).toMatchObject({
      name: "ExtensionConnectionError",
    });
    expect(errors).not.toHaveBeenCalled();
    await client.storage.disconnect();
  },
);

clientTest(
  "keeps actions-mode API access available when sync is forbidden",
  async ({ start }) => {
    await start({ syncAccess: "actions" });
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        nativeFetch(input, {
          ...init,
          headers: { ...init?.headers, "x-halo-viewer-role": "public" },
        }),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connectExtension({ schema, relations: {} });
    if (client instanceof Error) throw client;
    expect(await client.api.title!()).toBe("Ready");
    const connected = await client.connected;
    if (connected instanceof Error) throw connected;
    expect(connected.storage).not.toBe(client.storage);
    const tx = connected.storage.transact();
    tx.set("items", { id: "local", label: "Local only" });
    await connected.storage.commit(tx);
    expect(connected.storage.query({ collection: "items" })).toHaveLength(1);
    expect(client.storage.query({ collection: "items" })).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    await client.storage.disconnect();
  },
);

clientTest(
  "completes background sync without replacing the mounted replica",
  async ({ start }) => {
    await start({});
    const client = await connectExtension({ schema, relations: {} });
    if (client instanceof Error) throw client;
    expect(await client.api.title!()).toBe("Ready");
    const connected = await client.connected;
    if (connected instanceof Error) throw connected;
    expect(connected.storage).toBe(client.storage);
    await client.storage.disconnect();
  },
);
