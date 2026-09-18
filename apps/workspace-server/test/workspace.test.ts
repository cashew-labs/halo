import {
  emptySessionSnapshot,
  reduceSessionUpdate,
  sessionMessages,
  sessionToolExecutions,
  type HaloClient,
  type TraceRecord,
} from "@get-halo/client";
import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { IdTokenClient } from "google-auth-library";
import { ControlPlaneTraceUploader } from "@get-halo/workspace-server";
import { expect } from "vitest";
import { contentText } from "@earendil-works/pi-ai";
import { m } from "@get-halo/shared/testing";
import { messageText } from "@get-halo/workspace-server/testing";
import { serverTest } from "./serverTest.js";

serverTest(
  "uploads archives through the control plane and retries rejected requests after restart",
  async ({ createServer, llm, http }) => {
    const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
    const uploader = new ControlPlaneTraceUploader({
      origin: http.url(""),
      auth: {
        async getIdTokenClient(audience) {
          expect(audience).toBe(http.url("/api/traces"));
          return new IdTokenClient({
            targetAudience: audience,
            idTokenProvider: {
              async fetchIdToken(target) {
                expect(target).toBe(audience);
                return token;
              },
            },
          });
        },
      },
    });
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const server = createServer({
      traceUploader: uploader,
      traceWorkspaceId: workspaceId,
    });
    await server.start();
    const session = await server.rpc.sessions.create();
    const prompt = server.rpc.sessions.prompt({
      ...session,
      text: "Archive me",
    });
    await llm.respond(m.assistant("Archived answer"));
    await prompt;
    const [trace] = await readTraces(server.workspaceRoot);
    const record = trace!.records[0]!;
    expect(record.workspaceId).toBe(workspaceId);
    const target = `/api/traces/${record.sessionId}/${record.traceId}`;
    const first = await http.request(target);
    expect(first.headers.authorization).toBe(`Bearer ${token}`);
    expect(first.headers["content-type"]).toBe("application/gzip");
    expect(await first.body()).toEqual(trace!.bytes);
    // The object reached storage, but its acknowledgement did not reach the client.
    first.respond("Upload acknowledgement lost", { status: 503 });
    await server.stop();
    expect(await readTraces(server.workspaceRoot)).toHaveLength(1);
    await server.start();
    const retried = await http.request(target);
    expect(await retried.body()).toEqual(trace!.bytes);
    retried.respond("", { status: 204 });
    await expect
      .poll(
        async () => (await readTraces(server.workspaceRoot, "archive")).length,
      )
      .toBe(1);
    expect(await readTraces(server.workspaceRoot, "pending")).toHaveLength(0);

    const next = server.rpc.sessions.prompt({
      ...session,
      text: "A later request",
    });
    await llm.respond(m.assistant("Another answer"));
    await next;
    const [secondTrace] = await readTraces(server.workspaceRoot);
    expect(secondTrace!.name).not.toBe(trace!.name);
    const secondRecord = secondTrace!.records[0]!;
    const second = await http.request(
      `/api/traces/${secondRecord.sessionId}/${secondRecord.traceId}`,
    );
    expect(await second.body()).toEqual(secondTrace!.bytes);
    second.respond("", { status: 204 });
    await expect
      .poll(
        async () => (await readTraces(server.workspaceRoot, "archive")).length,
      )
      .toBe(2);
  },
);

serverTest(
  "archives complete model and nested tool activity without a chat watcher",
  async ({ server, llm }) => {
    const session = await server.rpc.sessions.create();
    await server.rpc.workspace.writeFile({
      path: "notes.md",
      content: "Trace me",
    });
    const prompt = server.rpc.sessions.prompt({
      ...session,
      text: "Read notes",
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "read-notes",
        arguments: {
          js: 'return await tools.files.read({ path: "notes.md" });',
        },
      }),
    );
    await llm.respond(m.assistant("Your notes say Trace me."));
    await prompt;

    const [trace] = await readTraces(server.workspaceRoot);
    expect(trace).toBeDefined();
    expect(trace!.records[0]).toMatchObject({
      sessionId: session.sessionId,
      sequence: 0,
      type: "run.started",
    });
    expect(trace!.records.at(-1)).toMatchObject({
      type: "run.finished",
      data: { outcome: "completed" },
    });
    expect(trace!.records.map((record) => record.sequence)).toEqual(
      trace!.records.map((_, index) => index),
    );
    const starts = trace!.records.filter(
      (record) => record.type === "model.started",
    );
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({
      data: {
        model: { id: "scripted" },
        context: {
          systemPrompt: expect.any(String),
          tools: expect.arrayContaining([
            expect.objectContaining({ name: "exec" }),
          ]),
          messages: expect.arrayContaining([
            expect.objectContaining({ role: "user", content: "Read notes" }),
          ]),
        },
      },
    });
    expect(
      trace!.records.filter((record) => record.type === "model.payload"),
    ).toHaveLength(2);
    expect(
      trace!.records.filter((record) => record.type === "model.finished"),
    ).toHaveLength(2);
    const tool = trace!.records.find(
      (record) => record.type === "tool.started",
    )!;
    const integration = trace!.records.find(
      (record) => record.type === "integration.started",
    )!;
    expect(integration.parentSpanId).toBe(tool.spanId);
    expect(
      trace!.records.find((record) => record.type === "integration.finished"),
    ).toMatchObject({
      spanId: integration.spanId,
      data: { isError: false, result: expect.anything() },
    });
    expect(trace!.name).toMatch(
      /v1\/workspaces\/[\da-f-]+\/sessions\/[\da-f-]+\/[\da-f]{32}\.jsonl\.gz$/,
    );
    expect(JSON.stringify(trace!.records)).not.toContain("halo-e2e");
  },
);

serverTest(
  "adds immutable runs to a conversation after restart and separates concurrent sessions",
  async ({ server, llm }) => {
    const session = await server.rpc.sessions.create();
    const first = server.rpc.sessions.prompt({
      ...session,
      text: "First request",
    });
    await llm.respond(m.assistant("First answer"));
    await first;
    const [original] = await readTraces(server.workspaceRoot);
    await server.stop();
    await server.start();
    const other = await server.rpc.sessions.create();
    const second = server.rpc.sessions.prompt({
      ...session,
      text: "Continue later",
    });
    const separate = server.rpc.sessions.prompt({
      ...other,
      text: "Separate conversation",
    });
    await llm.respond(m.assistant("Answer one"));
    await llm.respond(m.assistant("Answer two"));
    await Promise.all([second, separate]);
    const traces = await readTraces(server.workspaceRoot);
    expect(traces).toHaveLength(3);
    expect(
      traces.find((trace) => trace.name === original!.name)?.bytes,
    ).toEqual(original!.bytes);
    expect(
      new Set(traces.map((trace) => trace.records[0]!.workspaceId)).size,
    ).toBe(1);
    expect(
      traces.filter(
        (trace) => trace.records[0]!.sessionId === session.sessionId,
      ),
    ).toHaveLength(2);
    for (const trace of traces) {
      expect(new Set(trace.records.map((record) => record.traceId)).size).toBe(
        1,
      );
      expect(
        new Set(trace.records.map((record) => record.sessionId)).size,
      ).toBe(1);
    }
  },
);

serverTest(
  "archives cancelled model calls and extension-defined runs",
  async ({ server, llm }) => {
    const session = await server.rpc.sessions.create();
    const prompt = server.rpc.sessions.prompt({
      ...session,
      text: "Keep working",
    });
    await llm.waitForRequest();
    await server.rpc.sessions.abort(session);
    await prompt;
    const external = await server.rpc.traces.start({
      sessionId: "extension-conversation",
      agent: { id: "expenses", version: "build-12" },
    });
    await server.rpc.traces.record({
      traceId: external.traceId,
      event: {
        type: "model.started",
        spanId: "1234567890abcdef",
        parentSpanId: external.spanId,
        data: { systemPrompt: "Extension-owned prompt" },
      },
    });
    await server.rpc.traces.finish({
      traceId: external.traceId,
      outcome: "failed",
    });
    const traces = await readTraces(server.workspaceRoot);
    expect(traces).toHaveLength(2);
    expect(
      traces
        .find((trace) => trace.records[0]!.sessionId === session.sessionId)
        ?.records.at(-1),
    ).toMatchObject({ data: { outcome: "cancelled" } });
    const extension = traces.find(
      (trace) => trace.records[0]!.sessionId === "extension-conversation",
    )!;
    expect(extension.records[0]).toMatchObject({
      data: { agent: { id: "expenses", version: "build-12" } },
    });
    expect(extension.records.at(-1)).toMatchObject({
      data: { outcome: "failed" },
    });
    await expect(
      server.rpc.traces.record({
        traceId: external.traceId,
        event: { type: "late", spanId: external.spanId },
      }),
    ).rejects.toThrow();
    await expect(
      server.rpc.traces.start({
        sessionId: "../escape",
        agent: { id: "expenses" },
      }),
    ).rejects.toThrow();
  },
);

serverTest(
  "retries pending uploads after restart without interrupting conversations",
  async ({ createServer, llm }) => {
    const uploads = new Map<string, Buffer>();
    let available = false;
    let attempted = false;
    const server = createServer({
      traceUploader: {
        async upload({ key, filePath }) {
          attempted = true;
          if (!available) return new Error("Storage unavailable");
          uploads.set(key, await fs.readFile(filePath));
        },
      },
    });
    await server.start();
    const session = await server.rpc.sessions.create();
    const prompt = server.rpc.sessions.prompt({
      ...session,
      text: "Work while storage is offline",
    });
    await llm.respond(m.assistant("Done"));
    await prompt;
    await expect.poll(() => attempted).toBe(true);
    expect(uploads.size).toBe(0);
    const [pending] = await readTraces(server.workspaceRoot);
    await server.stop();
    available = true;
    await server.start();
    await expect.poll(() => uploads.size).toBe(1);
    expect([...uploads.values()][0]).toEqual(pending!.bytes);
    await expect
      .poll(
        async () => (await readTraces(server.workspaceRoot, "pending")).length,
      )
      .toBe(0);
    expect(await readTraces(server.workspaceRoot, "archive")).toHaveLength(1);
  },
);

serverTest(
  "recovers a torn active file as one interrupted run",
  async ({ server }) => {
    const run = await server.rpc.traces.start({
      sessionId: "recover-session",
      agent: { id: "custom" },
    });
    const activePath = path.join(
      server.workspaceRoot,
      ".halo",
      "traces",
      "active",
      "recover-session",
      `${run.traceId}.jsonl`,
    );
    const active = await fs.readFile(activePath, "utf8");
    await server.stop();
    const [completed] = await readTraces(server.workspaceRoot);
    await fs.rm(
      path.join(
        server.workspaceRoot,
        ".halo",
        "traces",
        "pending",
        completed!.name,
      ),
    );
    // Reproduce the durable bytes left by a process killed partway through its next append.
    await fs.writeFile(activePath, `${active}{"partial":`);
    await server.start();
    const [recovered] = await readTraces(server.workspaceRoot);
    expect(recovered!.records).toHaveLength(2);
    expect(recovered!.records.at(-1)).toMatchObject({
      traceId: run.traceId,
      sequence: 1,
      type: "run.finished",
      data: { outcome: "interrupted" },
    });
    await server.stop();
    await server.start();
    expect(await readTraces(server.workspaceRoot)).toHaveLength(1);
  },
);

async function readTraces(workspaceRoot: string, state = "pending") {
  const root = path.join(workspaceRoot, ".halo", "traces", state);
  const files = await fs
    .readdir(root, { recursive: true })
    .catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return [];
      throw cause;
    });
  return await Promise.all(
    files
      .filter((file) => file.endsWith(".jsonl.gz"))
      .map(async (name) => {
        const bytes = await fs.readFile(path.join(root, name));
        // SAFETY: The test reads the public versioned JSONL trace archive produced by the server.
        const records = gunzipSync(bytes)
          .toString("utf8")
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line) as TraceRecord);
        return { name, records, bytes };
      }),
  );
}

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

serverTest("reads files prepared by the tool fixture", async ({ server }) => {
  await server.rpc.testApi.invokeTool({
    path: "files.write",
    input: { path: "notes.md", content: "Prepared notes" },
  });
  expect(await server.rpc.workspace.readFile({ path: "notes.md" })).toBe(
    "Prepared notes",
  );
});

serverTest(
  "continues a seeded conversation after restarting the server",
  async ({ server, llm }) => {
    const saved = await server.rpc.testApi.seedSession({
      title: "Saved notes",
      messages: [
        { role: "user", content: "Blue notebook", timestamp: Date.now() },
      ],
    });
    expect(await server.rpc.sessions.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ...saved, title: "Saved notes" }),
      ]),
    );
    await server.stop();
    await server.start();

    const continued = server.rpc.sessions.prompt({
      ...saved,
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
    await continued;
    expect(assistantReplies(await server.rpc.sessions.snapshot(saved))).toEqual(
      ["Blue notebook → Continue"],
    );
  },
);

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
    const js = `await tools.files.read({ path: "notes.md" }); return await tools.bash.run({ command: ${JSON.stringify(command)} });`;
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
          js: `return await tools.bash.run({ command: ${JSON.stringify(command)} });`,
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

serverTest(
  "kills nested bash.run after the default 10s timeout",
  { timeout: 25_000 },
  async ({ server, llm }) => {
    const session = await server.rpc.sessions.create();
    const prompt = server.rpc.sessions.prompt({
      ...session,
      text: "Run the command",
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "default-timeout",
        arguments: {
          js: `return await tools.bash.run({ command: "sleep 30" });`,
        },
      }),
    );
    await expect
      .poll(
        async () => {
          const execution = sessionToolExecutions(
            await server.rpc.sessions.snapshot(session),
          ).find((item) => item.id === "default-timeout");
          const content = execution?.result?.content;
          if (content === undefined) return "";
          return content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("");
        },
        { timeout: 20_000 },
      )
      .toMatch(/timed out after 10000 ms/i);
    await llm.respond(m.assistant("Done."));
    await prompt;
  },
);
