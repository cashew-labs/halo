import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { m } from "@get-halo/shared/testing";
import { WorkspaceService } from "../src/workspace/WorkspaceService.js";
import { serverTest } from "./serverTest.js";

serverTest(
  "searches saved text and conversation messages without document content",
  async ({ server, llm }) => {
    await server.rpc.workspace.writeFile({
      path: "notes.txt",
      content: "The silver marmot sleeps here.",
    });
    await server.rpc.workspace.writeFile({
      path: "marmot.pdf",
      content: "silver marmot",
    });
    await server.rpc.workspace.writeFile({
      path: "marmot.docx",
      content: "silver marmot",
    });
    await server.rpc.workspace.writeFile({
      path: "large.txt",
      content: "x".repeat(5 * 1024 * 1024 + 1),
    });

    const session = await server.rpc.sessions.create();
    const prompt = server.rpc.sessions.prompt({
      ...session,
      text: "Find the silver marmot",
    });
    await llm.respond(m.assistant("I found a silver marmot."));
    await prompt;
    const named = await server.rpc.testApi.seedSession({
      title: "Silver marmot report",
      messages: [],
    });

    const result = await server.rpc.workspace.search({
      query: "SILVER MARMOT",
    });
    const fileHit = result.hits.find(
      (hit) =>
        hit.kind === "file" &&
        hit.path === "notes.txt" &&
        hit.source === "content",
    );
    expect(fileHit).toBeDefined();
    expect(
      fileHit?.snippet.slice(
        fileHit.snippetMatch.start,
        fileHit.snippetMatch.end,
      ),
    ).toBe("silver marmot");
    expect(
      result.hits.filter(
        (hit) =>
          hit.kind === "session" &&
          hit.sessionId === session.sessionId &&
          hit.source === "name",
      ),
    ).toEqual([]);
    expect(
      result.hits.some(
        (hit) =>
          hit.kind === "session" &&
          hit.sessionId === named.sessionId &&
          hit.source === "name",
      ),
    ).toBe(true);
    expect(
      result.hits.some(
        (hit) =>
          hit.kind === "session" &&
          hit.sessionId === session.sessionId &&
          hit.source === "content",
      ),
    ).toBe(true);
    expect(result.hits.some((hit) => hit.path === "marmot.pdf")).toBe(false);
    expect(result.hits.some((hit) => hit.path === "marmot.docx")).toBe(false);
    expect(result.skippedOversizedFiles).toBe(1);
    expect(
      (await server.rpc.workspace.search({ query: "absent phrase" })).hits,
    ).toEqual([]);
  },
);

serverTest(
  "searches visible Markdown text in document order",
  async ({ server }) => {
    await server.rpc.workspace.writeFile({
      path: "notes.md",
      content: "# foo\n\n[other](foo)\n\nfo**o**\n",
    });

    const result = await server.rpc.workspace.search({ query: "foo" });
    const hits = result.hits.filter(
      (hit) =>
        hit.kind === "file" &&
        hit.path === "notes.md" &&
        hit.source === "content",
    );
    expect(hits.map((hit) => hit.matchIndex)).toEqual([0, 1]);
    expect(
      hits.map((hit) =>
        hit.snippet.slice(hit.snippetMatch.start, hit.snippetMatch.end),
      ),
    ).toEqual(["foo", "foo"]);
    expect(hits[1]?.snippet).toContain("other");
    expect(hits[1]?.snippet).not.toContain("[other](foo)");
  },
);

serverTest("skips files removed after listing", async ({ server }) => {
  await server.rpc.workspace.writeFile({
    path: "removed.txt",
    content: "silver marmot",
  });
  await server.rpc.workspace.writeFile({
    path: "kept.txt",
    content: "silver marmot",
  });

  const listPaths = WorkspaceService.prototype.listPaths;
  const listing = vi
    .spyOn(WorkspaceService.prototype, "listPaths")
    .mockImplementationOnce(async function (this: WorkspaceService) {
      const paths = await listPaths.call(this);
      await fs.unlink(path.join(server.workspaceRoot, "removed.txt"));
      return paths;
    });
  try {
    const result = await server.rpc.workspace.search({
      query: "silver marmot",
    });
    expect(result.hits.some((hit) => hit.path === "kept.txt")).toBe(true);
    expect(result.hits.some((hit) => hit.path === "removed.txt")).toBe(false);
  } finally {
    listing.mockRestore();
  }
});

serverTest(
  "does not search a directory replaced with a symlink after listing",
  async ({ server }) => {
    const workspaceDir = path.join(server.workspaceRoot, "notes");
    const outsideDir = path.join(
      path.dirname(server.workspaceRoot),
      "outside-notes",
    );
    await fs.mkdir(workspaceDir);
    await fs.writeFile(path.join(workspaceDir, "entry.txt"), "safe text");
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, "entry.txt"), "outside secret");

    const listPaths = WorkspaceService.prototype.listPaths;
    const listing = vi
      .spyOn(WorkspaceService.prototype, "listPaths")
      .mockImplementationOnce(async function (this: WorkspaceService) {
        const paths = await listPaths.call(this);
        await fs.rename(workspaceDir, `${workspaceDir}-old`);
        await fs.symlink(outsideDir, workspaceDir, "dir");
        return paths;
      });
    try {
      await expect(
        server.rpc.workspace.search({ query: "outside secret" }),
      ).rejects.toThrow("Workspace search failed");
    } finally {
      listing.mockRestore();
    }
  },
);
