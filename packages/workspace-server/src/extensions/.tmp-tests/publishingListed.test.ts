import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import type { ExtensionArtifact } from "@get-halo/client";
import { serverTest } from "../../../test/serverTest.js";
import { buildBooksArtifact, writeLocalExtension } from "./appFixtures.js";

const appId = "12345678-1234-1234-1234-123456789abc";
const listedTest = serverTest.extend<{ artifact: ExtensionArtifact }>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
  artifact: async ({}, use) => await use(await buildBooksArtifact()),
});

listedTest("a frozen project stays listed as publishing until it is released", async ({ server, artifact }) => {
  await writeLocalExtension({ workspaceRoot: server.workspaceRoot, id: "books", artifact });
  await server.rpc.extensions.reload();
  await server.rpc.extensions.freeze({ id: "books", appId });
  expect(await server.rpc.extensions.list()).toEqual([{ id: "books", url: "", displayName: "Books", publishing: { appId } }]);
  // A manifest that cannot be read still lists the project under its ID.
  await fs.writeFile(path.join(server.workspaceRoot, ".halo/extensions/books/package.json"), "{");
  expect(await server.rpc.extensions.list()).toEqual([{ id: "books", url: "", displayName: "books", publishing: { appId } }]);
  await fs.writeFile(path.join(server.workspaceRoot, ".halo/extensions/books/package.json"), JSON.stringify({ name: "books", halo: { displayName: "Books", icon: "Notebook" } }));
  expect(await server.rpc.extensions.list()).toEqual([{ id: "books", url: "", displayName: "Books", icon: "Notebook", publishing: { appId } }]);
  // Keeping it local restarts it as an ordinary extension.
  await server.rpc.extensions.release({ id: "books", appId });
  expect(await server.rpc.extensions.list()).toMatchObject([{ id: "books", url: expect.stringMatching(/^http/) }]);
  expect((await server.rpc.extensions.list())[0]).not.toHaveProperty("publishing");
});
