import {
  emptySessionSnapshot,
  reduceSessionUpdate,
  sessionMessages,
  sessionToolExecutions,
  type HaloClient,
} from "@get-halo/client";
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { contentText } from "@earendil-works/pi-ai";
import { m } from "@get-halo/shared/testing";
import { messageText } from "@get-halo/workspace-server/testing";
import { serverTest } from "./serverTest.js";

serverTest(
  "lists saved conversations during overlapping requests and a pending response",
  async ({ server, llm }) => {
    const saved = await server.rpc.sessions.create();
    const save = server.rpc.sessions.prompt({
      ...saved,
      text: "Saved conversation",
    });
    await llm.respond(m.assistant("Saved answer."));
    await save;
    await server.rpc.sessions.close(saved);

    const active = await server.rpc.sessions.create();
    const answer = server.rpc.sessions.prompt({
      ...active,
      text: "Active conversation",
    });
    await llm.waitForRequest();

    const [firstListing, secondListing] = await Promise.all([
      server.rpc.sessions.list(),
      server.rpc.sessions.list(),
      server.rpc.sessions.snapshot(saved),
    ]);
    for (const listing of [firstListing, secondListing]) {
      expect(
        listing.map(({ sessionId, title }) => ({ sessionId, title })),
      ).toEqual(
        expect.arrayContaining([
          { ...saved, title: "Saved conversation" },
          { ...active, title: "Active conversation" },
        ]),
      );
    }

    await llm.respond(m.assistant("Active answer completed."));
    await answer;
  },
);

serverTest(
  "continues each conversation with its own history after restarting the server",
  async ({ server, llm }) => {
    const notebook = await server.rpc.sessions.create();
    const saveNotebook = server.rpc.sessions.prompt({
      ...notebook,
      text: "Blue notebook",
    });
    await llm.respond(m.assistant("Saved the notebook."));
    await saveNotebook;

    const bicycle = await server.rpc.sessions.create();
    const saveBicycle = server.rpc.sessions.prompt({
      ...bicycle,
      text: "Red bicycle",
    });
    await llm.respond(m.assistant("Saved the bicycle."));
    await saveBicycle;

    await server.stop();
    await server.start();

    const recallNotebook = server.rpc.sessions.prompt({
      ...notebook,
      text: "Continue",
    });
    await llm.respond(({ messages }) =>
      m.assistant(
        messages
          .filter((message) => message.role === "user")
          .map((message) => messageText(message))
          .join(" → "),
      ),
    );
    await recallNotebook;
    expect(
      assistantReplies(await server.rpc.sessions.snapshot(notebook)),
    ).toEqual(["Saved the notebook.", "Blue notebook → Continue"]);

    const recallBicycle = server.rpc.sessions.prompt({
      ...bicycle,
      text: "Continue",
    });
    await llm.respond(({ messages }) =>
      m.assistant(
        messages
          .filter((message) => message.role === "user")
          .map((message) => messageText(message))
          .join(" → "),
      ),
    );
    await recallBicycle;
    expect(
      assistantReplies(await server.rpc.sessions.snapshot(bicycle)),
    ).toEqual(["Saved the bicycle.", "Red bicycle → Continue"]);
  },
);

serverTest("reads, writes, and lists workspace files", async ({ server }) => {
  expect(await server.rpc.workspace.get()).toMatchObject({
    workspaceRoot: server.workspaceRoot,
  });

  await server.rpc.workspace.writeFile({
    path: "notes/today.md",
    content: "# Today",
  });
  expect(await server.rpc.workspace.readFile({ path: "notes/today.md" })).toBe(
    "# Today",
  );
  expect(await server.rpc.workspace.listPaths()).toEqual(["notes/today.md"]);
});

serverTest(
  "omits hidden and dependency files from workspace listings",
  async ({ server }) => {
    await server.harness.files.write({
      path: path.join(server.workspaceRoot, ".hidden", "secret.txt"),
      content: "secret",
    });
    await server.harness.files.write({
      path: path.join(server.workspaceRoot, ".git", "config"),
      content: "repository",
    });
    await server.harness.files.write({
      path: path.join(server.workspaceRoot, "node_modules", "pkg.js"),
      content: "dependency",
    });
    await server.harness.files.write({
      path: path.join(server.workspaceRoot, "src", ".cache", "x"),
      content: "cache",
    });

    expect(await server.rpc.workspace.listPaths()).toEqual(["src/"]);
  },
);

serverTest(
  "publishes workspace file creates and deletes while ignoring updates and hidden files",
  async ({ server }) => {
    const events = await server.rpc.workspace.events();
    const directoryCreated = events.next();
    await fs.mkdir(path.join(server.workspaceRoot, "src"));
    await expect(directoryCreated).resolves.toEqual({
      done: false,
      value: [{ type: "create", path: "src/" }],
    });

    const initial = events.next();
    await server.harness.files.write({
      path: path.join(server.workspaceRoot, "src", "existing.ts"),
      content: "original",
    });
    await expect(initial).resolves.toEqual({
      done: false,
      value: [{ type: "create", path: "src/existing.ts" }],
    });
    await server.rpc.workspace.listPaths();

    const created = events.next();
    await server.harness.files.write({
      path: path.join(server.workspaceRoot, "src", "created.ts"),
      content: "created",
    });
    await expect(created).resolves.toEqual({
      done: false,
      value: [{ type: "create", path: "src/created.ts" }],
    });

    const deleted = events.next();
    await server.harness.files.write({
      path: path.join(server.workspaceRoot, "src", "created.ts"),
      content: "updated",
    });
    await server.harness.files.write({
      path: path.join(server.workspaceRoot, ".hidden", "ignored.ts"),
      content: "ignored",
    });
    await fs.rm(path.join(server.workspaceRoot, "src", "existing.ts"));
    await expect(deleted).resolves.toEqual({
      done: false,
      value: [{ type: "delete", path: "src/existing.ts" }],
    });

    await events.return();
  },
);

serverTest("rejects files outside the public workspace", async ({ server }) => {
  await expect(
    server.rpc.workspace.writeFile({
      path: ".env",
      content: "SECRET=1",
    }),
  ).rejects.toThrow("'.env' is not a workspace file");
  await expect(
    server.rpc.workspace.writeFile({
      path: "../outside.txt",
      content: "outside",
    }),
  ).rejects.toThrow("'../outside.txt' is not a workspace file");
  await expect(
    server.rpc.workspace.readFile({ path: "../outside.txt" }),
  ).rejects.toThrow("'../outside.txt' is not a workspace file");
});

serverTest("disables the tool bridge outside E2E runs", async ({ server }) => {
  await expect(
    server.rpc.testHarness.invokeTool({
      path: "files.write",
      input: { path: "notes.md", content: "This must not be written" },
    }),
  ).rejects.toThrow("The testing API is unavailable outside an E2E run.");
});

serverTest(
  "serves each workspace independently in the same process",
  async ({ server, createServer }) => {
    const otherRoot = path.join(server.harness.paths.root, "other-workspace");
    await fs.mkdir(otherRoot);
    const other = createServer({ workspaceRoot: otherRoot });
    await other.start();

    await server.rpc.workspace.writeFile({
      path: "notes.md",
      content: "First workspace",
    });
    await other.rpc.workspace.writeFile({
      path: "notes.md",
      content: "Second workspace",
    });

    expect(await server.rpc.workspace.get()).toMatchObject({
      workspaceRoot: server.workspaceRoot,
    });
    expect(await other.rpc.workspace.get()).toMatchObject({
      workspaceRoot: otherRoot,
    });
    expect(await server.rpc.workspace.readFile({ path: "notes.md" })).toBe(
      "First workspace",
    );
    expect(await other.rpc.workspace.readFile({ path: "notes.md" })).toBe(
      "Second workspace",
    );
  },
);

serverTest(
  "releases its port after the selected workspace fails to open",
  async ({ server }) => {
    await server.stop();
    const savedWorkspace = path.join(
      server.harness.paths.root,
      "saved-workspace",
    );
    await fs.rename(server.workspaceRoot, savedWorkspace);
    await fs.writeFile(
      server.workspaceRoot,
      "This is a file, not a workspace directory.",
    );

    await expect(server.start()).rejects.toThrow(
      "The selected workspace must be a directory.",
    );

    await fs.rm(server.workspaceRoot);
    await fs.rename(savedWorkspace, server.workspaceRoot);
    await server.start();
    await server.rpc.workspace.writeFile({
      path: "notes.md",
      content: "Ready after repair",
    });
    expect(await server.rpc.workspace.readFile({ path: "notes.md" })).toBe(
      "Ready after repair",
    );
  },
);

serverTest(
  "moves a folder while preserving the contents of a renamed note",
  async ({ server }) => {
    await server.rpc.workspace.createEntry({
      path: "Notes",
      kind: "directory",
    });
    await server.rpc.workspace.createEntry({
      path: "Archive",
      kind: "directory",
    });
    await server.rpc.workspace.createEntry({
      path: "Notes/Today.md",
      kind: "file",
    });
    await server.rpc.workspace.writeFile({
      path: "Notes/Today.md",
      content: "Keep this note",
    });
    await server.rpc.workspace.moveEntry({
      source: "Notes/Today.md",
      destination: "Notes/Plan.md",
    });
    await server.rpc.workspace.moveEntry({
      source: "Notes",
      destination: "Archive/Notes",
    });
    expect(
      await server.rpc.workspace.readFile({ path: "Archive/Notes/Plan.md" }),
    ).toBe("Keep this note");
    expect(await server.rpc.workspace.listPaths()).toEqual([
      "Archive/Notes/Plan.md",
    ]);
  },
);

serverTest(
  "refuses to overwrite an existing note when creating or moving files",
  async ({ server }) => {
    await server.rpc.workspace.writeFile({
      path: "Archive/Notes/Plan.md",
      content: "Keep this note",
    });
    await expect(
      server.rpc.workspace.createEntry({
        path: "Archive/Notes/Plan.md",
        kind: "file",
      }),
    ).rejects.toThrow("already exists");
    await server.rpc.workspace.createEntry({ path: "Other.md", kind: "file" });
    await expect(
      server.rpc.workspace.moveEntry({
        source: "Other.md",
        destination: "Archive/Notes/Plan.md",
      }),
    ).rejects.toThrow("already exists");
    expect(
      await server.rpc.workspace.readFile({ path: "Archive/Notes/Plan.md" }),
    ).toBe("Keep this note");
  },
);

serverTest("refuses to move a folder into itself", async ({ server }) => {
  await server.rpc.workspace.writeFile({
    path: "Archive/Notes/Plan.md",
    content: "Keep this note",
  });
  await expect(
    server.rpc.workspace.moveEntry({
      source: "Archive",
      destination: "Archive/Notes/Nested",
    }),
  ).rejects.toThrow("cannot be moved into itself");
});

serverTest(
  "rejects creating entries outside the visible workspace",
  async ({ server }) => {
    for (const invalid of [
      "../outside.md",
      ".pi/secret.md",
      "node_modules/new.md",
      "",
    ]) {
      await expect(
        server.rpc.workspace.createEntry({ path: invalid, kind: "file" }),
      ).rejects.toThrow("not a workspace file");
    }
  },
);

serverTest(
  "does not create files through a workspace symlink",
  async ({ server }) => {
    const outside = path.join(server.harness.paths.root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(
      outside,
      path.join(server.workspaceRoot, "Shortcut"),
      "junction",
    );
    await expect(
      server.rpc.workspace.createEntry({
        path: "Shortcut/file.md",
        kind: "file",
      }),
    ).rejects.toThrow("not a workspace file");
    expect(await fs.readdir(outside)).toEqual([]);
  },
);

serverTest(
  "renames a note when only capitalization changes",
  async ({ server }) => {
    await server.rpc.workspace.writeFile({
      path: "notes.md",
      content: "Keep my note",
    });
    await server.rpc.workspace.moveEntry({
      source: "notes.md",
      destination: "Notes.md",
    });
    expect(await server.rpc.workspace.listPaths()).toEqual(["Notes.md"]);
    expect(await server.rpc.workspace.readFile({ path: "Notes.md" })).toBe(
      "Keep my note",
    );
  },
);

serverTest(
  "deletes files and folders while preserving neighboring files",
  async ({ server }) => {
    await server.rpc.workspace.writeFile({
      path: "Notes/Today.txt",
      content: "remove",
    });
    await server.rpc.workspace.writeFile({ path: "Keep.txt", content: "keep" });
    await server.rpc.workspace.deleteEntry({ path: "Notes/Today.txt" });
    expect(await server.rpc.workspace.listPaths()).toEqual([
      "Keep.txt",
      "Notes/",
    ]);
    await server.rpc.workspace.writeFile({
      path: "Notes/Nested/Plan.txt",
      content: "remove",
    });
    await server.rpc.workspace.deleteEntry({ path: "Notes" });
    expect(await server.rpc.workspace.listPaths()).toEqual(["Keep.txt"]);
    expect(await server.rpc.workspace.readFile({ path: "Keep.txt" })).toBe(
      "keep",
    );
  },
);

serverTest(
  "rejects deleting entries outside the visible workspace",
  async ({ server }) => {
    for (const invalid of ["", "../outside", ".pi"]) {
      await expect(
        server.rpc.workspace.deleteEntry({ path: invalid }),
      ).rejects.toThrow("not a workspace file");
    }
  },
);

serverTest(
  "serves an image preview with its original bytes and media type",
  async ({ server }) => {
    const image =
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="blue"/></svg>';
    await server.rpc.workspace.writeFile({ path: "Image.SVG", content: image });

    const preview = await server.rpc.workspace.previewFile({
      path: "Image.SVG",
    });

    expect(preview.kind).toBe("image");
    if (preview.kind !== "image") throw new Error("Expected image preview");
    expect(preview.file.type).toBe("image/svg+xml");
    expect(await preview.file.text()).toBe(image);
  },
);

serverTest("marks plain-text notes as editable", async ({ server }) => {
  await server.rpc.workspace.writeFile({
    path: "notes.txt",
    content: "Editable plain text",
  });

  expect(await server.rpc.workspace.previewFile({ path: "notes.txt" })).toEqual(
    { kind: "text" },
  );
});

serverTest("reports unsupported binary previews", async ({ server }) => {
  await server.harness.files.write({
    path: path.join(server.workspaceRoot, "archive.zip"),
    content: Buffer.from([80, 75, 0, 255]),
  });

  expect(
    await server.rpc.workspace.previewFile({ path: "archive.zip" }),
  ).toMatchObject({ kind: "unsupported" });
});

serverTest(
  "declines previews larger than the size limit",
  async ({ server }) => {
    const file = path.join(server.workspaceRoot, "large.txt");
    await fs.writeFile(file, "");
    await fs.truncate(file, 101 * 1024 * 1024);

    expect(
      await server.rpc.workspace.previewFile({ path: "large.txt" }),
    ).toMatchObject({ kind: "unsupported" });
  },
);

serverTest("rejects previews outside the workspace", async ({ server }) => {
  await expect(
    server.rpc.workspace.previewFile({ path: "../outside.txt" }),
  ).rejects.toThrow("not a workspace file");
});

serverTest("rejects previews through symlinks", async ({ server }) => {
  await server.rpc.workspace.writeFile({
    path: "notes.txt",
    content: "A note",
  });
  await fs.symlink(
    path.join(server.workspaceRoot, "notes.txt"),
    path.join(server.workspaceRoot, "link.txt"),
  );

  await expect(
    server.rpc.workspace.previewFile({ path: "link.txt" }),
  ).rejects.toThrow("not a workspace file");
});

function assistantReplies(
  session: Awaited<ReturnType<HaloClient["sessions"]["snapshot"]>>,
) {
  return sessionMessages(session).flatMap((message) =>
    message.role === "assistant" ? [contentText(message.content)] : [],
  );
}

serverTest(
  "finishes a conversation after the prompt request disconnects",
  async ({ server, llm }) => {
    const session = await server.rpc.sessions.create();
    const controller = new AbortController();
    const prompting = server.rpc.sessions.prompt(
      { ...session, text: "Keep going after I disconnect" },
      { signal: controller.signal },
    );
    const disconnected = expect(prompting).rejects.toThrow();
    await llm.waitForRequest();

    controller.abort();
    await disconnected;
    await llm.respond(m.assistant("I kept going."));

    await expect
      .poll(async () => await server.rpc.sessions.snapshot(session))
      .toMatchObject({
        lastRun: { status: "completed" },
      });
    expect(
      assistantReplies(await server.rpc.sessions.snapshot(session)),
    ).toEqual(["I kept going."]);

    const continued = server.rpc.sessions.prompt({
      ...session,
      text: "Thanks",
    });
    await llm.respond(m.assistant("You're welcome."));
    await continued;
    expect(
      assistantReplies(await server.rpc.sessions.snapshot(session)),
    ).toEqual(["I kept going.", "You're welcome."]);
  },
);

serverTest(
  "reconnects to a running conversation without losing or duplicating its answer",
  async ({ server, llm }) => {
    const session = await server.rpc.sessions.create();
    const initial = new AbortController();
    const watch = await server.rpc.sessions.watch(session, {
      signal: initial.signal,
    });
    const first = await watch.next();
    expect(first.value).toMatchObject({
      type: "snapshot",
      snapshot: { entries: [] },
    });

    const prompted = server.rpc.sessions.prompt({
      ...session,
      text: "Keep going while I reconnect",
    });
    await llm.waitForRequest();
    initial.abort();
    await watch.return();

    const reconnected = new AbortController();
    const updates = await server.rpc.sessions.watch(session, {
      signal: reconnected.signal,
    });
    const current = await updates.next();
    expect(current.value).toMatchObject({
      type: "snapshot",
      snapshot: {
        activeRun: { tools: [] },
        entries: [
          {
            type: "message",
            message: { role: "user", content: "Keep going while I reconnect" },
          },
        ],
      },
    });
    await llm.respond(m.assistant("I kept going."));
    await prompted;
    let state = emptySessionSnapshot();
    if (current.done) throw new Error("Expected a session snapshot");
    state = reduceSessionUpdate(state, current.value);
    for await (const item of updates) {
      state = reduceSessionUpdate(state, item);
      if (state.activeRun === undefined) {
        reconnected.abort();
        break;
      }
    }
    expect(
      sessionMessages(state).flatMap((message) =>
        "content" in message ? [contentText(message.content)] : [],
      ),
    ).toEqual(["Keep going while I reconnect", "I kept going."]);
    expect(await server.rpc.sessions.snapshot(session)).toMatchObject({
      entries: state.entries,
      lastRun: state.lastRun,
    });
  },
);

serverTest(
  "exposes the same exec activity through live updates, snapshots, and server restart",
  async ({ server, llm, http }) => {
    await server.rpc.workspace.writeFile({
      path: "notes.md",
      content: "Saved notes",
    });
    const session = await server.rpc.sessions.create();
    const controller = new AbortController();
    const watch = await server.rpc.sessions.watch(session, {
      signal: controller.signal,
    });
    let live = emptySessionSnapshot();
    const observed = (async () => {
      for await (const item of watch) {
        live = reduceSessionUpdate(live, item);
        if (live.lastRun?.status === "completed") break;
      }
    })();

    const prompt = server.rpc.sessions.prompt({
      ...session,
      text: "Read the notes and fetch the report",
    });
    const command = `curl --silent --fail '${http.url("/report")}'`;
    const js = `await tools.files.read({ path: "notes.md" }); return await tools.bash.run({ command: ${JSON.stringify(command)}, timeoutMs: 60000 });`;
    await llm.respond(
      m.tool.start("exec", { id: "report", arguments: { js } }),
    );
    const request = await http.request("/report");
    await expect
      .poll(() => sessionToolExecutions(live))
      .toMatchObject([
        {
          id: "report",
          type: "exec",
          status: "running",
          arguments: { js },
          calls: [
            {
              parentId: "report",
              tool: { path: "files.read" },
              arguments: { path: "notes.md" },
              status: "completed",
            },
            {
              parentId: "report",
              tool: { path: "bash.run" },
              arguments: { command },
              status: "running",
            },
          ],
        },
      ]);
    await expect
      .poll(async () => await server.rpc.sessions.snapshot(session))
      .toEqual(live);

    request.respond("The report is ready.");
    await llm.respond(m.assistant("Finished the report."));
    await prompt;
    await observed;
    controller.abort();
    expect(sessionToolExecutions(live)).toMatchObject([
      {
        id: "report",
        type: "exec",
        status: "completed",
        calls: [
          { tool: { path: "files.read" }, status: "completed" },
          { tool: { path: "bash.run" }, status: "completed" },
        ],
      },
    ]);
    expect(await server.rpc.sessions.snapshot(session)).toEqual(live);
    expect(new Set(live.entries.map((entry) => entry.id)).size).toBe(
      live.entries.length,
    );

    await server.stop();
    await server.start();
    expect(await server.rpc.sessions.snapshot(session)).toEqual(live);
  },
);

serverTest(
  "reopens a conversation after shutting down with a tool and viewer still active",
  { timeout: 20_000 },
  async ({ server, llm, http }) => {
    const session = await server.rpc.sessions.create();
    const watch = await server.rpc.sessions.watch(session);
    await watch.next();
    const prompting = server.rpc.sessions.prompt({
      ...session,
      text: "Fetch the report",
    });
    const disconnected = expect(prompting).rejects.toThrow();
    const command = `curl --silent --fail '${http.url("/pending-report")}'`;
    await llm.respond(
      m.tool.start("exec", {
        id: "pending-report",
        arguments: {
          js: `return await tools.bash.run({ command: ${JSON.stringify(command)}, timeoutMs: 60000 });`,
        },
      }),
    );
    await http.request("/pending-report");

    await server.stop();
    await disconnected;
    await server.start();

    const restored = await server.rpc.sessions.snapshot(session);
    expect(sessionMessages(restored)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Fetch the report" }),
      ]),
    );
    expect(restored.activeRun).toBeUndefined();
    expect(sessionToolExecutions(restored)).toMatchObject([
      { id: "pending-report", type: "exec", status: "failed" },
    ]);

    const continued = server.rpc.sessions.prompt({
      ...session,
      text: "Continue without the report",
    });
    await llm.respond(m.assistant("Continuing without it."));
    await continued;
    await expect
      .poll(async () =>
        assistantReplies(await server.rpc.sessions.snapshot(session)),
      )
      .toContain("Continuing without it.");
  },
);
