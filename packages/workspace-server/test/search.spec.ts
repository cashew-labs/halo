import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { m } from "@get-halo/shared/testing";
import { WorkspaceService } from "../src/workspace/WorkspaceService.js";
import { serverTest } from "./serverTest.js";

serverTest(
  "queries current conversation data through the shared read-only database tool",
  async ({ server }) => {
    const saved = await server.rpc.testApi.seedSession({
      title: "Timezone choice",
      messages: [
        {
          role: "user",
          content: "Use America/Los_Angeles for routine reminders.",
          timestamp: Date.now(),
        },
      ],
    });
    const found = await server.rpc.testApi.invokeTool({
      path: "database.query",
      input: {
        sql: "SELECT thread_id AS threadId, id, json_extract(record, '$.data.message.content') AS content FROM entries WHERE instr(record, ?) > 0",
        parameters: ["America/Los_Angeles"],
      },
    });
    expect(found).toEqual({
      rows: [
        {
          threadId: saved.sessionId,
          id: expect.any(Number),
          content: "Use America/Los_Angeles for routine reminders.",
        },
      ],
      truncated: false,
    });

    await server.rpc.testApi.seedSession({
      title: "New session",
      messages: [{ role: "user", content: "Later", timestamp: Date.now() }],
    });
    const latest = await server.rpc.testApi.invokeTool({
      path: "database.query",
      input: { sql: "SELECT count(*) AS count FROM halo_threads" },
    });
    expect(latest).toEqual({ rows: [{ count: 2 }], truncated: false });

    await expect(
      server.rpc.testApi.invokeTool({
        path: "database.query",
        input: { sql: "SELECT * FROM missing_table" },
      }),
    ).rejects.toThrow("Database query failed");
    await server.rpc.testApi.seedSession({
      title: "After failed query",
      messages: [],
    });

    await expect(
      server.rpc.testApi.invokeTool({
        path: "database.query",
        input: { sql: "DELETE FROM halo_threads" },
      }),
    ).rejects.toThrow("Only one read-only SELECT query is allowed");
    await expect(
      server.rpc.testApi.invokeTool({
        path: "database.query",
        input: {
          sql: "WITH doomed AS (SELECT id FROM halo_threads) DELETE FROM halo_threads",
        },
      }),
    ).rejects.toThrow("Database query failed");
    await expect(
      server.rpc.testApi.invokeTool({
        path: "database.query",
        input: { sql: "SELECT 1; DELETE FROM halo_threads" },
      }),
    ).rejects.toThrow("Only one read-only SELECT query is allowed");
    expect(
      await server.rpc.testApi.invokeTool({
        path: "database.query",
        input: { sql: "SELECT count(*) AS count FROM halo_threads" },
      }),
    ).toEqual({ rows: [{ count: 3 }], truncated: false });

    const many = await server.rpc.testApi.invokeTool({
      path: "database.query",
      input: {
        sql: "WITH nums(x) AS (VALUES(1),(2),(3),(4),(5),(6),(7),(8),(9),(10)) SELECT a.x, b.x AS y FROM nums a CROSS JOIN nums b",
      },
    });
    expect(many).toEqual({ rows: expect.any(Array), truncated: true });
    expect(many).toHaveProperty("rows.length", 50);

    expect(
      await server.rpc.testApi.invokeTool({
        path: "database.query",
        input: {
          sql: "SELECT ? AS content",
          parameters: ["x".repeat(10_000)],
        },
      }),
    ).toEqual({
      rows: [{ content: `${"x".repeat(2_000)}… [cell truncated]` }],
      truncated: true,
    });
  },
);

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

    const session = await server.rpc.thread.new();
    const prompt = server.promptAndWait({
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
