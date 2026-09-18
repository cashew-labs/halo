import * as errore from "errore";
import {
  emptySessionSnapshot,
  reduceSessionUpdate,
  sessionMessages,
  sessionToolExecutions,
  type HaloClient,
  type TraceRecord,
  type SessionSummary,
  type SessionSummariesUpdate,
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
    await llm.waitForRequest();
    expect(await server.rpc.sessions.list()).toEqual([
      expect.objectContaining({ ...session, isRunning: true }),
    ]);
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
    expect(await server.rpc.sessions.list()).toEqual([
      expect.objectContaining({
        ...session,
        isRunning: false,
        latestResultId: expect.any(String),
      }),
    ]);

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
  const pdfSkill = await server.harness.files.read(
    path.join(server.workspaceRoot, ".agents", "skills", "pdf", "SKILL.md"),
  );
  const pdfSkillText = Buffer.from(pdfSkill).toString("utf8");
  expect(pdfSkillText).toContain("Inspect rendered pages with `viewImage`");

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
  "returns validated workspace images directly to the model",
  async ({ server, llm }) => {
    const images = [
      {
        path: "pixel.png",
        mimeType: "image/png",
        base64:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
      },
      {
        path: "pixel.jpg",
        mimeType: "image/jpeg",
        base64:
          "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z",
      },
      {
        path: "pixel.webp",
        mimeType: "image/webp",
        base64:
          "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==",
      },
    ] as const;
    for (const image of images) {
      await server.harness.files.write({
        path: path.join(server.workspaceRoot, image.path),
        content: Buffer.from(image.base64, "base64"),
      });
    }
    await server.harness.files.write({
      path: path.join(server.workspaceRoot, "corrupt.png"),
      content: Buffer.concat([
        Buffer.from(images[0].base64, "base64").subarray(0, 8),
        Buffer.from("not valid PNG data"),
      ]),
    });
    await server.harness.files.write({
      path: path.join(server.workspaceRoot, "too-large.png"),
      content: Buffer.concat([
        Buffer.from(images[0].base64, "base64").subarray(0, 8),
        Buffer.alloc(20 * 1024 * 1024),
      ]),
    });

    const session = await server.rpc.sessions.create();
    const prompted = server.rpc.sessions.prompt({
      ...session,
      text: "View the workspace images",
    });
    await llm.respond([
      ...images.map((image, index) =>
        m.tool.start("viewImage", {
          id: `image-${index}`,
          arguments: { path: image.path },
        }),
      ),
      m.tool.start("viewImage", {
        id: "invalid-image",
        arguments: { path: "corrupt.png" },
      }),
      m.tool.start("viewImage", {
        id: "large-image",
        arguments: { path: "too-large.png" },
      }),
    ]);
    await llm.respond(m.assistant("I viewed the supported images."));
    await prompted;

    const executions = sessionToolExecutions(
      await server.rpc.sessions.snapshot(session),
    );
    expect(executions.slice(0, 3)).toMatchObject(
      images.map((image) => ({
        tool: { path: "viewImage", displayName: "View image" },
        status: "completed",
        type: "tool",
        result: {
          content: [
            { type: "text", text: `Viewed image ${image.path}.` },
            {
              type: "image",
              data: image.base64,
              mimeType: image.mimeType,
            },
          ],
          details: {
            path: image.path,
            mimeType: image.mimeType,
            sizeBytes: Buffer.from(image.base64, "base64").length,
          },
        },
      })),
    );
    expect(executions.slice(3)).toMatchObject([
      {
        id: "invalid-image",
        tool: { path: "viewImage", displayName: "View image" },
        status: "failed",
      },
      {
        id: "large-image",
        tool: { path: "viewImage", displayName: "View image" },
        status: "failed",
      },
    ]);
  },
);

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
  "rejects test API operations when the host leaves them disabled",
  async ({ createServer }) => {
    const server = createServer({ testApiEnabled: false });
    await server.start();
    await expect(
      server.rpc.testApi.seedSession({
        title: "Should not seed",
        messages: [],
      }),
    ).rejects.toThrow("The test API is disabled for this workspace server.");
    expect(await server.rpc.workspace.get()).toMatchObject({
      workspaceRoot: server.workspaceRoot,
    });
  },
);

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

serverTest(
  "pushes session summaries and catches up after reconnect and restart",
  async ({ server, llm }) => {
    using cleanup = new errore.DisposableStack();
    const first = new AbortController();
    cleanup.defer(() => first.abort());
    const updates = await server.rpc.sessions.watchSummaries(undefined, {
      signal: first.signal,
    });
    expect((await updates.next()).value).toEqual({
      type: "snapshot",
      sessions: [],
    });
    const session = await server.rpc.sessions.create();
    expect((await updates.next()).value).toMatchObject({
      type: "updated",
      session: { ...session, isRunning: false },
    });

    const prompting = server.rpc.sessions.prompt({
      ...session,
      text: "Work without an open conversation",
    });
    const running = await nextSummary(
      updates,
      (summary) => summary.isRunning && summary.title !== undefined,
    );
    expect(running).toMatchObject({
      ...session,
      title: "Work without an open conversation",
    });
    await llm.respond(m.assistant("First result"));
    await prompting;
    const completed = await nextSummary(
      updates,
      (summary) => !summary.isRunning && summary.latestResultId !== undefined,
    );
    expect(completed.latestResultId).toBeDefined();
    first.abort();

    // Finish another run while this client is disconnected.
    const again = server.rpc.sessions.prompt({
      ...session,
      text: "Finish while I am disconnected",
    });
    await llm.respond(m.assistant("Second result"));
    await again;
    const reconnect = new AbortController();
    cleanup.defer(() => reconnect.abort());
    const resumed = await server.rpc.sessions.watchSummaries(undefined, {
      signal: reconnect.signal,
    });
    const current = await resumed.next();
    expect(current.value).toMatchObject({
      type: "snapshot",
      sessions: [{ ...session, isRunning: false }],
    });
    if (current.done || current.value.type !== "snapshot")
      throw new Error("Expected summary snapshot");
    const resultId = current.value.sessions[0]!.latestResultId;
    expect(resultId).toBeDefined();
    expect(resultId).not.toBe(completed.latestResultId);

    // Aborting an active run also pushes its settled status.
    const aborted = server.rpc.sessions.prompt({
      ...session,
      text: "Stop this run",
    });
    await nextSummary(resumed, (summary) => summary.isRunning);
    await llm.waitForRequest();
    await server.rpc.sessions.abort(session);
    await aborted;
    const stopped = await nextSummary(
      resumed,
      (summary) => !summary.isRunning && summary.latestResultId !== resultId,
    );
    expect(stopped.latestResultId).toBeDefined();
    reconnect.abort();
    await server.stop();
    await server.start();
    const restart = new AbortController();
    cleanup.defer(() => restart.abort());
    const restored = await server.rpc.sessions.watchSummaries(undefined, {
      signal: restart.signal,
    });
    expect((await restored.next()).value).toMatchObject({
      type: "snapshot",
      sessions: [
        {
          ...session,
          isRunning: false,
          latestResultId: stopped.latestResultId,
        },
      ],
    });
    restart.abort();
  },
);

serverTest(
  "pushes named seeded sessions to every summary subscriber",
  async ({ server }) => {
    using cleanup = new errore.DisposableStack();
    const controller = new AbortController();
    cleanup.defer(() => controller.abort());
    const first = await server.rpc.sessions.watchSummaries(undefined, {
      signal: controller.signal,
    });
    const second = await server.rpc.sessions.watchSummaries(undefined, {
      signal: controller.signal,
    });
    await first.next();
    await second.next();
    const session = await server.rpc.testApi.seedSession({
      title: "Saved title",
      messages: [
        { role: "user", content: "Initial question", timestamp: Date.now() },
      ],
    });
    for (const stream of [first, second]) {
      const summary = await nextSummary(
        stream,
        (item) => item.title === "Saved title",
      );
      expect(summary).toMatchObject({
        ...session,
        title: "Saved title",
        isRunning: false,
      });
    }
    controller.abort();
  },
);

serverTest(
  "pushes failed run completion without an open conversation",
  async ({ server, llm }) => {
    using cleanup = new errore.DisposableStack();
    const controller = new AbortController();
    cleanup.defer(() => controller.abort());
    const updates = await server.rpc.sessions.watchSummaries(undefined, {
      signal: controller.signal,
    });
    await updates.next();
    const session = await server.rpc.sessions.create();
    const prompted = server.rpc.sessions.prompt({
      ...session,
      text: "Denied model",
    });
    await nextSummary(updates, (summary) => summary.isRunning);
    await llm.respond(m.error("Model access denied"));
    await prompted;
    const failed = await nextSummary(
      updates,
      (summary) => !summary.isRunning && summary.latestResultId !== undefined,
    );
    expect(await server.rpc.sessions.snapshot(session)).toMatchObject({
      lastRun: { id: failed.latestResultId, status: "failed" },
    });
  },
);

async function nextSummary(
  updates: AsyncIterable<SessionSummariesUpdate>,
  matches: (summary: SessionSummary) => boolean,
) {
  // Consume without returning the iterator so the same connection remains usable.
  const iterator = updates[Symbol.asyncIterator]();
  while (true) {
    const next = await iterator.next();
    if (next.done)
      throw new Error(
        "Session summary stream ended before the expected update",
      );
    if (next.value.type === "updated" && matches(next.value.session))
      return next.value.session;
  }
}

serverTest(
  "uploads original file bytes into the workspace without overwriting files",
  async ({ server }) => {
    await server.rpc.workspace.createEntry({
      path: "Uploads",
      kind: "directory",
    });
    const bytes = new Uint8Array([0, 255, 13, 10, 128, 42]);
    const file = new File([bytes], "local.bin", {
      type: "application/octet-stream",
    });
    expect(
      await server.rpc.workspace.uploadFile({ path: "Uploads/data.bin", file }),
    ).toEqual({ path: "Uploads/data.bin" });
    expect(
      await fs.readFile(path.join(server.workspaceRoot, "Uploads/data.bin")),
    ).toEqual(Buffer.from(bytes));
    expect(await server.rpc.workspace.listPaths()).toContain(
      "Uploads/data.bin",
    );
    await expect(
      server.rpc.workspace.uploadFile({
        path: "Uploads/data.bin",
        file: new File(["replacement"], "local.bin"),
      }),
    ).rejects.toThrow("already exists");
    expect(
      await fs.readFile(path.join(server.workspaceRoot, "Uploads/data.bin")),
    ).toEqual(Buffer.from(bytes));
  },
);

serverTest(
  "rejects file uploads outside the workspace and through symlinks",
  async ({ server }) => {
    const outside = path.join(server.harness.paths.root, "outside-upload");
    await fs.mkdir(outside);
    await fs.symlink(
      outside,
      path.join(server.workspaceRoot, "Shortcut"),
      "junction",
    );
    const file = new File(["local data"], "notes.txt");
    for (const invalid of [
      "../outside.txt",
      ".halo/state.db",
      "Shortcut/notes.txt",
      "",
    ]) {
      await expect(
        server.rpc.workspace.uploadFile({ path: invalid, file }),
      ).rejects.toThrow("not a workspace file");
    }
    expect(await fs.readdir(outside)).toEqual([]);
  },
);

serverTest(
  "saves client-named images without overwriting or accepting path traversal",
  async ({ createServer }) => {
    const server = createServer();
    await server.start();
    const id = "11111111-1111-4111-8111-111111111111";
    const file = new File([new Uint8Array([1, 2, 3])], "clipboard.png", {
      type: "image/png",
    });
    const input = { documentPath: "notes.md", file, id };
    const src = `image-${id}.png`;
    expect(await server.rpc.workspace.saveImage(input)).toEqual({ src });
    await expect(server.rpc.workspace.saveImage(input)).rejects.toThrow();
    await expect(
      server.rpc.workspace.saveImage({ ...input, id: "../../outside" }),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(server.workspaceRoot, src))).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(
      await server.rpc.workspace.saveImage({ documentPath: "notes.md", file }),
    ).toMatchObject({ src: expect.stringMatching(/^image-[0-9a-f-]+\.png$/) });
  },
);

serverTest(
  "configures persistent hotkeys through chat and streams changes to clients",
  async ({ server, llm }) => {
    const controller = new AbortController();
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => controller.abort());
    const updates = await server.rendererRpc.hotkeys.watch(undefined, {
      signal: controller.signal,
    });
    expect((await updates.next()).value).toEqual([]);
    const session = await server.rpc.sessions.create();
    const prompt = server.rpc.sessions.prompt({
      ...session,
      text: "Make Cmd+Shift+K open a new chat tab",
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "save-hotkey",
        arguments: {
          js: 'return await tools.hotkeys.save({ label: "Quick chat", accelerator: "Cmd+Shift+K", action: { type: "newTab" } });',
        },
      }),
    );
    await llm.respond(m.assistant("Your hotkey is ready."));
    await prompt;
    const [hotkey] = await server.rpc.hotkeys.list();
    expect(hotkey).toMatchObject({
      label: "Quick chat",
      accelerator: "CmdOrCtrl+Shift+K",
      action: { type: "newTab" },
    });
    expect((await updates.next()).value).toEqual([hotkey]);
    const id = hotkey!.id;
    await expect(
      server.rpc.hotkeys.save({
        label: "Conflict",
        accelerator: "Shift+Control+K",
        action: { type: "closeTab" },
      }),
    ).rejects.toThrow("already assigned");
    await expect(
      server.rpc.hotkeys.save({
        label: "Reserved",
        accelerator: "Cmd+T",
        action: { type: "closeTab" },
      }),
    ).rejects.toThrow("reserved");
    await expect(
      server.rpc.hotkeys.save({
        label: "Typing",
        accelerator: "K",
        action: { type: "newTab" },
      }),
    ).rejects.toThrow("CmdOrCtrl");
    await expect(
      server.rpc.hotkeys.save({
        label: "Escape workspace",
        accelerator: "Cmd+Shift+L",
        action: { type: "openFile", path: "../secret.md" },
      }),
    ).rejects.toThrow("workspace-relative");
    await expect(
      server.rpc.hotkeys.save({
        label: "Empty task",
        accelerator: "CmdOrCtrl+Shift+L",
        action: { type: "runAgent", prompt: "   " },
      }),
    ).rejects.toThrow("needs an instruction");
    const changed = await server.rpc.hotkeys.save({
      ...hotkey!,
      label: "Draft daily notes",
      accelerator: "CmdOrCtrl+Shift+L",
      action: {
        type: "runAgent",
        prompt: "Create daily.md with a summary of the workspace notes.",
      },
    });
    expect((await updates.next()).value).toEqual([changed]);
    controller.abort();
    await server.stop();
    await server.start();
    expect(await server.rpc.hotkeys.list()).toEqual([changed]);
    const listed = await server.rpc.testApi.invokeTool({
      path: "hotkeys.list",
      input: {},
    });
    expect(listed).toEqual([changed]);
    await server.rpc.testApi.invokeTool({
      path: "hotkeys.remove",
      input: { id },
    });
    expect(await server.rendererRpc.hotkeys.list()).toEqual([]);
    await server.stop();
    await server.start();
    expect(await server.rpc.hotkeys.list()).toEqual([]);
  },
);

serverTest(
  "streams extension snapshots across reload, reconnect, and restart failure",
  async ({ server }) => {
    using cleanup = new errore.DisposableStack();
    const controller = new AbortController();
    cleanup.defer(() => controller.abort());
    const first = await server.rpc.extensions.watch(undefined, {
      signal: controller.signal,
    });
    const second = await server.rendererRpc.extensions.watch(undefined, {
      signal: controller.signal,
    });
    expect((await first.next()).value).toEqual([]);
    expect((await second.next()).value).toEqual([]);

    const directory = path.join(
      server.workspaceRoot,
      ".halo/extensions/snapshot-test",
    );
    const manifest = path.join(directory, "package.json");
    const launcher = path.join(directory, "dist/start.mjs");
    await fs.mkdir(path.dirname(launcher), { recursive: true });
    await fs.writeFile(manifest, JSON.stringify({ name: "snapshot-test" }));
    // A real process implements the extension host's readiness and shutdown protocol.
    await fs.writeFile(
      launcher,
      `
    import http from "node:http";
    const server = http.createServer((_, response) => response.end("Ready"));
    server.listen(0, "127.0.0.1", () => {
      process.send("http://127.0.0.1:" + server.address().port + "/view/");
    });
    process.on("message", (message) => {
      if (message === "shutdown") server.close(() => process.exit(0));
    });
  `,
    );
    // Opening another watch concurrently must include this reload, either in its
    // first snapshot or in the next buffered update.
    const opening = server.rpc.extensions.watch(undefined, {
      signal: controller.signal,
    });
    await Promise.all([
      server.rpc.extensions.reload(),
      server.rpc.extensions.reload(),
    ]);
    const started = await server.rpc.extensions.list();
    expect(started).toMatchObject([
      { id: "snapshot-test", displayName: "snapshot-test" },
    ]);
    for (const stream of [first, second]) {
      expect((await stream.next()).value).toEqual(started);
      expect((await stream.next()).value).toEqual(started);
    }
    const racing = await opening;
    const initial = await racing.next();
    if (initial.done) throw new Error("Expected initial extension snapshot");
    if (initial.value.length === 0)
      expect((await racing.next()).value).toEqual(started);
    else expect(initial.value).toEqual(started);
    await racing.return();

    await fs.writeFile(
      manifest,
      JSON.stringify({
        name: "snapshot-test",
        halo: { displayName: "Renamed", icon: "Calendar" },
      }),
    );
    await server.rpc.extensions.reload();
    const renamed = [
      { ...started[0], displayName: "Renamed", icon: "Calendar" },
    ];
    expect((await first.next()).value).toEqual(renamed);
    expect((await second.next()).value).toEqual(renamed);
    const reconnect = await server.rpc.extensions.watch(undefined, {
      signal: controller.signal,
    });
    expect((await reconnect.next()).value).toEqual(renamed);
    await reconnect.return();

    await fs.writeFile(manifest, "{");
    const failedFirst = expect(first.next()).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const failedSecond = expect(second.next()).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await server.rpc.extensions.reload();
    await Promise.all([failedFirst, failedSecond]);
    await fs.writeFile(manifest, JSON.stringify({ name: "snapshot-test" }));
    const recovered = await server.rpc.extensions.watch(undefined, {
      signal: controller.signal,
    });
    expect((await recovered.next()).value).toEqual(started);

    await server.rpc.extensions.restart({ id: "snapshot-test" });
    const restartUpdate = await recovered.next();
    if (restartUpdate.done)
      throw new Error("Expected restarted extension snapshot");
    const restarted = restartUpdate.value;
    expect(restarted).toMatchObject([
      { id: "snapshot-test", displayName: "snapshot-test" },
    ]);
    expect(restarted?.[0]?.url).not.toBe(started[0]?.url);
    await fs.rename(launcher, launcher + ".saved");
    await expect(
      server.rpc.extensions.restart({ id: "snapshot-test" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await recovered.next()).value).toEqual([]);
    await fs.rename(launcher + ".saved", launcher);
    await server.rpc.extensions.reload();
    expect((await recovered.next()).value).toMatchObject([
      { id: "snapshot-test" },
    ]);
    await fs.rm(directory, { recursive: true });
    await server.rpc.extensions.reload();
    expect((await recovered.next()).value).toEqual([]);

    const cancelled = new AbortController();
    const abortable = await server.rpc.extensions.watch(undefined, {
      signal: cancelled.signal,
    });
    await abortable.next();
    const pending = expect(abortable.next()).rejects.toSatisfy(
      errore.isAbortError,
    );
    cancelled.abort();
    await pending;
    // An idle subscription must not hold server shutdown open.
    await server.stop();
  },
);
