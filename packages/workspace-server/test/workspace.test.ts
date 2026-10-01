import * as errore from "errore";
import {
  createHaloClient,
  createWorkspaceRemote,
  workspaceSchema,
  connectHaloClient,
  haloProtocolVersion,
  haloSupportedProtocols,
  emptySessionSnapshot,
  isThreadUnread,
  reduceSessionUpdate,
  sessionMessages,
  sessionToolExecutions,
  type HaloClient,
  type Hotkey,
  type TraceRecord,
  type SessionEvent,
  type SessionSummary,
  type SessionSummariesUpdate,
} from "@get-halo/client";
import fs from "node:fs/promises";
import nodeHttp from "node:http";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { ControlPlaneTraceUploader } from "@get-halo/workspace-server";
import { assert, expect, vi } from "vitest";
import { contentText } from "@earendil-works/pi-ai";
import { m } from "@get-halo/shared/testing";
import { messageText } from "@get-halo/workspace-server/testing";
import { serverTest } from "./serverTest.js";
import { TandemClient } from "@tanishqkancharla/tandem-core";
import { haloSchemaToTandemSchema } from "@get-halo/client";

const attachmentFixtures = [
  { name: "picture.png", images: 1 },
  { name: "picture.jpg", images: 1 },
  { name: "picture.webp", images: 1 },
  { name: "picture.gif", images: 1 },
  { name: "picture.avif", images: 1 },
  { name: "picture.svg", images: 1 },
  { name: "picture.tiff", images: 1 },
  { name: "picture.bmp", images: 1 },
  { name: "picture.ico", images: 1 },
  { name: "picture.heic", images: 1 },
  { name: "picture.heif", images: 1 },
  { name: "document.pdf", text: "orange heron", images: 2 },
  { name: "scan.pdf", images: 1 },
  { name: "document.docx", text: "scarlet robin", images: 1 },
  { name: "workbook.xlsx", text: "indigo jay", images: 0 },
  { name: "slides.pptx", text: "turquoise crane", images: 1 },
  { name: "document.odt", text: "bronze eagle", images: 0 },
  { name: "workbook.ods", text: "ruby duck", images: 0 },
  { name: "slides.odp", text: "sapphire swan", images: 0 },
  { name: "drawing.odg", text: "copper falcon", images: 0 },
  { name: "book.epub", text: "teal swallow", images: 0 },
  { name: "document.rtf", text: "amber lynx", images: 0 },
  { name: "notes.txt", text: "cedar fox", images: 0 },
  { name: "windows.txt", text: "violet hare", images: 0 },
  { name: "notes.md", text: "silver otter", images: 0 },
  { name: "data.csv", text: "golden finch", images: 0 },
  { name: "data.tsv", text: "river owl", images: 0 },
  { name: "data.json", text: "blue whale", images: 0 },
  { name: "source.ts", text: "green turtle", images: 0 },
  { name: "document.html", text: "red kite", images: 0 },
];

for (const fixture of attachmentFixtures) {
  serverTest(
    `sends ${fixture.name} attachment contents to the model`,
    async ({ server, llm }) => {
      const session = await server.rpc.thread.new();
      const bytes = await fs.readFile(
        path.join(import.meta.dirname, "fixtures", "attachments", fixture.name),
      );
      // Browsers may omit MIME types. Conversion must still use the file's contents.
      const file = new File([bytes], fixture.name);
      const prompt = server.promptAndWait({
        ...session,
        text: "Explain the attachment",
        files: [file],
      });
      const response = llm.respond(({ messages }) => {
        const message = messages.findLast((item) => item.role === "user");
        assert(message !== undefined && Array.isArray(message.content));
        if (fixture.text !== undefined)
          expect(messageText(message)).toContain(fixture.text);
        expect(messageText(message)).toContain(fixture.name);
        const images = message.content.filter(
          (part) => part.type === "image_url",
        );
        expect(images).toHaveLength(fixture.images);
        for (const image of images) {
          expect(image.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
          const data = Buffer.from(
            image.image_url.url.split(",")[1]!,
            "base64",
          );
          expect([...data.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
          expect(data.length).toBeGreaterThan(100);
        }
        return m.assistant("I received the attachment contents.");
      });
      await Promise.all([prompt, response]);
      const snapshot = await server.rpc.thread.snapshot(session);
      const user = sessionMessages(snapshot).find(
        (message) => message.role === "user",
      );
      assert(user?.role === "user");
      expect(user.displayText).toBe("Explain the attachment");
      expect(user.attachments).toHaveLength(1);
      expect(user.attachments![0]!.name).toBe(fixture.name);
      expect(
        await fs.readFile(
          path.join(server.workspaceRoot, user.attachments![0]!.path),
        ),
      ).toEqual(bytes);
      expect((await server.rpc.thread.list())[0]!.title).toBe(
        "Explain the attachment",
      );
    },
  );
}

serverTest(
  "retains attachment-only messages, duplicate filenames, and model context after restart",
  async ({ server, llm }) => {
    const session = await server.rpc.thread.new();
    const files = [
      new File(["First note: crimson fox"], "notes.txt"),
      new File(["Second note: cobalt owl"], "notes.txt"),
    ];
    const prompt = server.promptAndWait({ ...session, text: "", files });
    await llm.respond(m.assistant("I have both files."));
    await prompt;
    await server.stop();
    await server.start();
    const snapshot = await server.rpc.thread.snapshot(session);
    const user = sessionMessages(snapshot).find(
      (message) => message.role === "user",
    );
    assert(user?.role === "user");
    expect(user.attachments).toHaveLength(2);
    expect(user.attachments![0]!.path).not.toBe(user.attachments![1]!.path);
    expect((await server.rpc.thread.list())[0]!.title).toBe(
      "notes.txt, notes.txt",
    );
    const next = server.promptAndWait({
      ...session,
      text: "Recall both notes",
    });
    await llm.respond(({ messages }) => {
      const context = messages.map(messageText).join("\n");
      expect(context).toContain("crimson fox");
      expect(context).toContain("cobalt owl");
      return m.assistant("The notes mention a crimson fox and cobalt owl.");
    });
    await next;
  },
);

serverTest(
  "rejects unreadable and oversized attachments without sending an empty user message",
  async ({ server, llm }) => {
    const session = await server.rpc.thread.new();
    const cases = [
      {
        files: [new File([new Uint8Array([0, 1, 2, 3])], "archive.bin")],
        reason: "file format cannot be read",
      },
      {
        files: [new File(["invalid PDF"], "corrupt.pdf")],
        reason: "PDF could not be read",
      },
      {
        files: [new File(["invalid image"], "corrupt.png")],
        reason: "image could not be decoded",
      },
      { files: [new File([], "empty.txt")], reason: "empty" },
      {
        files: [new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.txt")],
        reason: "too large",
      },
      {
        files: Array.from({ length: 11 }, () => new File(["note"], "note.txt")),
        reason: "up to 10 files",
      },
      {
        files: [new File(["x".repeat(200_001)], "long.txt")],
        reason: "200,000 characters",
      },
      {
        files: [new File(["note"], "../note.txt")],
        reason: "invalid filename",
      },
    ];
    for (const input of cases) {
      await expect(
        server.promptAndWait({
          ...session,
          text: "Read these",
          files: input.files,
        }),
      ).rejects.toThrow(input.reason);
      expect(
        sessionMessages(await server.rpc.thread.snapshot(session)),
      ).toHaveLength(0);
    }
    const prompt = server.promptAndWait({
      ...session,
      text: "Try a readable file",
      files: [new File(["Valid note"], "valid.txt")],
    });
    await llm.respond(m.assistant("The valid file works."));
    await prompt;
  },
);

serverTest(
  "uploads archives through the control plane and retries rejected requests after restart",
  async ({ createServer, http }) => {
    const token = "workspace-test-runtime-token";
    const uploader = new ControlPlaneTraceUploader({
      origin: http.url(""),
      token,
    });
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const server = createServer({
      traceUploader: uploader,
      traceWorkspaceId: workspaceId,
    });
    await server.start();
    const run = await server.rpc.traces.start({
      sessionId: "upload-session",
      agent: { id: "test" },
    });
    await server.rpc.traces.record({
      traceId: run.traceId,
      event: { type: "test.event", spanId: run.spanId },
    });
    await server.rpc.traces.finish({
      traceId: run.traceId,
      outcome: "completed",
    });
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

    const nextRun = await server.rpc.traces.start({
      sessionId: "upload-session",
      agent: { id: "test" },
    });
    await server.rpc.traces.record({
      traceId: nextRun.traceId,
      event: { type: "test.event", spanId: nextRun.spanId },
    });
    await server.rpc.traces.finish({
      traceId: nextRun.traceId,
      outcome: "completed",
    });
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

serverTest("archives extension-defined runs", async ({ server }) => {
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
  expect(traces).toHaveLength(1);
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
});

serverTest(
  "retries pending uploads after restart",
  async ({ createServer }) => {
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
    const run = await server.rpc.traces.start({
      sessionId: "retry-session",
      agent: { id: "test" },
    });
    await server.rpc.traces.record({
      traceId: run.traceId,
      event: { type: "test.event", spanId: run.spanId },
    });
    await server.rpc.traces.finish({
      traceId: run.traceId,
      outcome: "completed",
    });
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
    const saved = await server.rpc.thread.new();
    const save = server.promptAndWait({
      ...saved,
      text: "Saved conversation",
    });
    await llm.respond(m.assistant("Saved answer."));
    await save;
    await server.rpc.thread.close(saved);

    const active = await server.rpc.thread.new();
    const answer = server.promptAndWait({
      ...active,
      text: "Active conversation",
    });
    await llm.waitForRequest();

    const [firstListing, secondListing] = await Promise.all([
      server.rpc.thread.list(),
      server.rpc.thread.list(),
      server.rpc.thread.snapshot(saved),
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
    const notebook = await server.rpc.thread.new();
    const saveNotebook = server.promptAndWait({
      ...notebook,
      text: "Blue notebook",
    });
    await llm.respond(m.assistant("Saved the notebook."));
    await saveNotebook;

    const bicycle = await server.rpc.thread.new();
    const saveBicycle = server.promptAndWait({
      ...bicycle,
      text: "Red bicycle",
    });
    await llm.respond(m.assistant("Saved the bicycle."));
    await saveBicycle;

    await server.stop();
    await server.start();

    const recallNotebook = server.promptAndWait({
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
      assistantReplies(await server.rpc.thread.snapshot(notebook)),
    ).toEqual(["Saved the notebook.", "Blue notebook → Continue"]);

    const recallBicycle = server.promptAndWait({
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
    expect(assistantReplies(await server.rpc.thread.snapshot(bicycle))).toEqual(
      ["Saved the bicycle.", "Red bicycle → Continue"],
    );
  },
);

serverTest(
  "reports missing event threads as BAD_REQUEST",
  async ({ server }) => {
    const consume = async () => {
      const events = await server.rpc.thread.events({
        sessionId: "missing-thread",
      });
      for await (const event of events) {
        throw new Error(`A missing thread emitted ${event.type}`);
      }
    };
    await expect(consume()).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Session 'missing-thread' does not exist.",
    });
  },
);

serverTest(
  "reads closed pending work without resuming it until a live stream is opened",
  async ({ server, llm }) => {
    const session = await server.rpc.thread.new();
    const accepted = await server.rpc.thread.prompt({
      ...session,
      text: "Continue after reopening",
    });
    const waiting = server.rpc.thread.wait({ ...session, ...accepted });
    const interrupted = expect(waiting).rejects.toThrow();
    await llm.waitForRequest();
    await server.rpc.thread.close(session);
    await interrupted;
    const saved = await server.rpc.thread.snapshot(session);
    expect(sessionMessages(saved)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "Continue after reopening",
        }),
      ]),
    );
    expect(await server.rpc.thread.list()).toEqual([
      expect.objectContaining({ ...session, isRunning: false }),
    ]);
    expect(
      (await server.rpc.workspace.search({ query: "Continue after reopening" }))
        .hits,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "session", ...session }),
      ]),
    );
    // A second close fails only if these reads left the runtime closed.
    await expect(server.rpc.thread.close(session)).rejects.toThrow(
      "is not open",
    );
    const controller = new AbortController();
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => controller.abort());
    const events = await server.rpc.thread.events(session, {
      signal: controller.signal,
    });
    expect((await events.next()).value).toMatchObject({ type: "snapshot" });
    await llm.respond(m.assistant("Resumed after reopening."));
    await expect
      .poll(async () =>
        assistantReplies(await server.rpc.thread.snapshot(session)),
      )
      .toEqual(["Resumed after reopening."]);
    expect(
      (await server.rpc.thread.snapshot(session)).activeRun,
    ).toBeUndefined();
  },
);

serverTest(
  "keeps saved history and observable summary status consistent without loading a thread",
  async ({ server, llm }) => {
    const session = await server.rpc.thread.new();
    const done = server.promptAndWait({
      ...session,
      text: "Remember sapphire robin",
    });
    await llm.respond(m.assistant("Sapphire robin remembered."));
    await done;
    const live = await server.rpc.thread.snapshot(session);
    const summaries = await server.rpc.thread.list();
    const summary = summaries[0]!;
    assert(summary.latestResultId !== undefined);
    expect(summary).toMatchObject({
      title: "Remember sapphire robin",
      isRunning: false,
    });
    await server.rpc.thread.close(session);

    expect(await server.rpc.thread.snapshot(session)).toEqual(live);
    expect(await server.rpc.thread.list()).toEqual(summaries);
    const controller = new AbortController();
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => controller.abort());
    const updates = await server.rpc.thread.watchSummaries(undefined, {
      signal: controller.signal,
    });
    expect((await updates.next()).value).toEqual({
      type: "snapshot",
      sessions: summaries,
    });
    await server.rpc.thread.markRead({
      ...session,
      observedResultId: summary.latestResultId,
    });
    const read = { ...summary, readReceiptCursorId: summary.latestResultId };
    expect((await updates.next()).value).toEqual({
      type: "updated",
      session: read,
    });
    await server.rpc.thread.markDone(session);
    expect((await updates.next()).value).toEqual({
      type: "updated",
      session: { ...read, markedDone: true },
    });
    expect(await server.rpc.thread.list()).toEqual([
      { ...read, markedDone: true },
    ]);
    await expect(server.rpc.thread.close(session)).rejects.toThrow(
      "is not open",
    );
    controller.abort();
    await server.stop();
    await server.start();
    expect(await server.rpc.thread.snapshot(session)).toEqual(live);
    expect(await server.rpc.thread.list()).toEqual([
      { ...read, markedDone: true },
    ]);
    await expect(server.rpc.thread.close(session)).rejects.toThrow(
      "is not open",
    );
  },
);

serverTest(
  "unloads idle threads but retains active work and event subscribers",
  async ({ server, llm }) => {
    const schedule = globalThis.setTimeout;
    // Accelerate only the five-minute idle clock, leaving network timers real.
    using clock = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...args) =>
        schedule(callback, delay === 300_000 ? 1_000 : delay, ...args),
      );
    const idle = await server.rpc.thread.new();
    const watched = await server.rpc.thread.new();
    const busy = await server.rpc.thread.new();
    const controller = new AbortController();
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => controller.abort());
    const events = await server.rpc.thread.events(watched, {
      signal: controller.signal,
    });
    expect((await events.next()).value).toMatchObject({ type: "snapshot" });
    const accepted = await server.rpc.thread.prompt({
      ...busy,
      text: "Keep working while idle threads unload",
    });
    await llm.waitForRequest();
    await server.rpc.thread.markDone(idle);

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await expect(server.rpc.thread.close(idle)).rejects.toThrow("is not open");
    expect(
      (await server.rpc.thread.list()).find(
        (item) => item.sessionId === busy.sessionId,
      ),
    ).toMatchObject({ isRunning: true });
    await llm.respond(m.assistant("Work survived idle collection."));
    expect(
      await server.rpc.thread.wait({ ...busy, ...accepted }),
    ).toMatchObject({ status: "completed" });

    const reopened = await server.rpc.thread.events(idle, {
      signal: controller.signal,
    });
    expect((await reopened.next()).value).toMatchObject({ type: "snapshot" });
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 500));
    // It stayed loaded while subscribed, and disconnect starts a fresh full delay.
    await server.rpc.thread.close(watched);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await expect(server.rpc.thread.close(idle)).rejects.toThrow("is not open");
    await expect(server.rpc.thread.close(busy)).rejects.toThrow("is not open");

    // Concurrent acquisitions after unload share one storage owner and one admission.
    const input = {
      ...busy,
      text: "Continue after unloading",
      clientMessageId: "after-idle",
    };
    const [first, retry] = await Promise.all([
      server.rpc.thread.prompt(input),
      server.rpc.thread.prompt(input),
    ]);
    expect(retry).toEqual(first);
    await llm.respond(m.assistant("Continued after unloading."));
    await server.rpc.thread.wait({ ...busy, ...first });
    expect(assistantReplies(await server.rpc.thread.snapshot(busy))).toEqual([
      "Work survived idle collection.",
      "Continued after unloading.",
    ]);
    expect(clock).toHaveBeenCalledWith(expect.any(Function), 300_000);
  },
);

serverTest(
  "deduplicates thread and prompt request IDs and resumes waiting after restart",
  async ({ server, llm }) => {
    const [session, retry] = await Promise.all([
      server.rpc.thread.new({ requestId: "durable-thread" }),
      server.rpc.thread.new({ requestId: "durable-thread" }),
    ]);
    expect(retry).toEqual(session);
    expect(
      await server.rpc.thread.new({ requestId: "different-thread" }),
    ).not.toEqual(session);
    const input = {
      ...session,
      text: "Remember this once",
      clientMessageId: "durable-retry",
    };
    const accepted = await server.rpc.thread.prompt(input);
    const waiting = server.rpc.thread.wait({ ...session, ...accepted });
    const disconnected = expect(waiting).rejects.toThrow();
    await llm.waitForRequest();
    await server.stop();
    await disconnected;
    await server.start();
    expect(
      await server.rpc.thread.new({ requestId: "durable-thread" }),
    ).toEqual(session);
    await llm.respond(m.assistant("Remembered once."));
    await expect
      .poll(async () =>
        assistantReplies(await server.rpc.thread.snapshot(session)),
      )
      .toEqual(["Remembered once."]);
    expect(await server.rpc.thread.prompt(input)).toEqual(accepted);
    await server.rpc.thread.wait({ ...session, ...accepted });
    const settled = await server.rpc.thread.snapshot(session);
    expect(
      sessionMessages(settled).filter((message) => message.role === "user"),
    ).toHaveLength(1);
    await server.stop();
    await server.start();
    expect(await server.rpc.thread.prompt(input)).toEqual(accepted);
    await server.rpc.thread.wait({ ...session, ...accepted });
    expect(await server.rpc.thread.snapshot(session)).toEqual(settled);
  },
);

serverTest(
  "waits for distinct submissions admitted during the same run",
  async ({ server, llm }) => {
    const session = await server.rpc.thread.new();
    const first = await server.rpc.thread.prompt({
      ...session,
      text: "Start the report",
    });
    await llm.waitForRequest();
    const second = await server.rpc.thread.prompt({
      ...session,
      text: "Include the budget",
    });
    expect(second.submissionId).not.toBe(first.submissionId);
    const firstDone = server.rpc.thread.wait({ ...session, ...first });
    const secondDone = server.rpc.thread.wait({ ...session, ...second });
    await llm.respond(m.assistant("Starting the report."));
    await llm.respond(({ messages }) => {
      expect(
        messageText(messages.findLast((message) => message.role === "user")!),
      ).toBe("Include the budget");
      return m.assistant("Report with budget complete.");
    });
    expect(await firstDone).toMatchObject({ status: "completed" });
    expect(await secondDone).toMatchObject({ status: "completed" });
    expect(assistantReplies(await server.rpc.thread.snapshot(session))).toEqual(
      ["Starting the report.", "Report with budget complete."],
    );
    await expect(
      server.rpc.thread.wait({ ...session, submissionId: 999999 }),
    ).rejects.toThrow("Unknown thread submission");
  },
);

serverTest(
  "keeps full chat history when Durable compacts model context",
  async ({ server, llm }) => {
    const old = "Old context. ".repeat(45_000);
    const recent = "Recent context. ".repeat(6_500);
    const session = await server.rpc.testApi.seedSession({
      title: "Long conversation",
      messages: [
        { role: "user", content: old, timestamp: Date.now() },
        { role: "user", content: recent, timestamp: Date.now() },
      ],
    });
    const prompting = server.promptAndWait({
      ...session,
      text: "Continue after compaction",
    });
    await llm.respond(m.assistant("COMPACTED_OLD_CONTEXT"));
    await llm.respond(({ messages }) => {
      const context = messages
        .map((message) => messageText(message))
        .join("\n");
      expect(context).toContain("COMPACTED_OLD_CONTEXT");
      expect(context).not.toContain(old);
      return m.assistant("Continued with compact context.");
    });
    await prompting;
    const snapshot = await server.rpc.thread.snapshot(session);
    expect(
      sessionMessages(snapshot)
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual([old, recent, "Continue after compaction"]);
    expect(assistantReplies(snapshot)).toEqual([
      "Continued with compact context.",
    ]);
    await server.stop();
    await server.start();
    expect(await server.rpc.thread.snapshot(session)).toEqual(snapshot);
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

    const session = await server.rpc.thread.new();
    const prompted = server.promptAndWait({
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
      await server.rpc.thread.snapshot(session),
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

serverTest(
  "runs file and shell operations through direct tools and exec",
  async ({ server, llm }) => {
    for (const surface of ["direct", "exec"] as const) {
      const session = await server.rpc.thread.new();
      const file = `${surface}.txt`;
      const prompt = server.promptAndWait({
        ...session,
        text: "Write, edit, patch, and read the notes",
      });
      const operations = [
        {
          name: "write",
          path: "files.write",
          args: { path: file, content: "alpha\nbeta\nalpha\n" },
          expected: { path: file },
        },
        {
          name: "edit",
          path: "files.edit",
          args: {
            path: file,
            oldText: "alpha",
            newText: "delta",
            replaceAll: true,
          },
          expected: { path: file, replacements: 2 },
        },
        {
          name: "patch",
          path: "files.patch",
          args: {
            patchText: `*** Begin Patch\n*** Update File: ${file}\n@@\n-beta\n+gamma\n*** End Patch`,
          },
          expected: { added: [], modified: [file], deleted: [] },
        },
        {
          name: "read",
          path: "files.read",
          args: { path: file, offset: 2, limit: 1 },
          expected: "gamma",
        },
        {
          name: "bash",
          path: "bash.run",
          args: { command: `cat ${file}` },
          expected: "delta\ngamma\ndelta\n",
        },
      ] as const;
      for (const [index, operation] of operations.entries()) {
        await llm.respond(
          m.tool.start(surface === "direct" ? operation.name : "exec", {
            id: `${surface}-${index}`,
            arguments:
              surface === "direct"
                ? operation.args
                : {
                    js: `return await tools.${operation.path}(${JSON.stringify(operation.args)});`,
                  },
          }),
        );
      }
      await llm.respond(({ messages }) => {
        for (const [index, operation] of operations.entries()) {
          const toolMessage = messages.find(
            (message) =>
              message.role === "tool" &&
              message.tool_call_id === `${surface}-${index}`,
          )!;
          const output = messageText(toolMessage);
          if (operation.name === "read" || operation.name === "bash") {
            if (surface === "direct")
              expect(output).toContain(operation.expected);
            else
              expect(JSON.parse(output)).toMatchObject({
                ok: true,
                data:
                  operation.name === "read"
                    ? { text: expect.stringContaining(operation.expected) }
                    : { stdout: operation.expected, code: 0 },
              });
          } else {
            expect(JSON.parse(output)).toMatchObject(
              surface === "direct"
                ? operation.expected
                : { ok: true, data: operation.expected },
            );
          }
        }
        return m.assistant("Operations complete.");
      });
      await prompt;
      expect(await server.rpc.workspace.readFile({ path: file })).toBe(
        "delta\ngamma\ndelta\n",
      );
    }
  },
);

serverTest(
  "denies the same capabilities through direct tools and exec",
  async ({ createServer, llm }) => {
    const server = createServer({ agentCapabilities: [] });
    await server.start();
    await server.rpc.workspace.writeFile({
      path: "protected.txt",
      content: "original",
    });
    const session = await server.rpc.thread.new();
    const prompt = server.promptAndWait({
      ...session,
      text: "Attempt restricted tools",
    });
    const operations = [
      {
        name: "read",
        path: "files.read",
        args: { path: "protected.txt" },
        capability: "workspace.files.read",
      },
      {
        name: "viewImage",
        path: "files.viewImage",
        args: { path: "protected.txt" },
        capability: "workspace.files.read",
      },
      {
        name: "write",
        path: "files.write",
        args: { path: "protected.txt", content: "changed" },
        capability: "workspace.files.write",
      },
      {
        name: "edit",
        path: "files.edit",
        args: {
          path: "protected.txt",
          oldText: "original",
          newText: "changed",
        },
        capability: "workspace.files.write",
      },
      {
        name: "patch",
        path: "files.patch",
        args: {
          patchText:
            "*** Begin Patch\n*** Update File: protected.txt\n@@\n-original\n+changed\n*** End Patch",
        },
        capability: "workspace.files.write",
      },
      {
        name: "bash",
        path: "bash.run",
        args: { command: "printf changed > protected.txt" },
        capability: "workspace.shell.execute",
      },
    ] as const;
    await llm.respond(
      operations.flatMap((operation) => [
        m.tool.start(operation.name, {
          id: `direct-${operation.name}`,
          arguments: operation.args,
        }),
        m.tool.start("exec", {
          id: `exec-${operation.name}`,
          arguments: {
            js: `return await tools.${operation.path}(${JSON.stringify(operation.args)});`,
          },
        }),
      ]),
    );
    await llm.respond(({ messages }) => {
      for (const operation of operations)
        for (const surface of ["direct", "exec"]) {
          const toolMessage = messages.find(
            (message) =>
              message.role === "tool" &&
              message.tool_call_id === `${surface}-${operation.name}`,
          )!;
          expect(messageText(toolMessage)).toContain(operation.capability);
          expect(messageText(toolMessage)).toContain("not granted");
        }
      return m.assistant("No restricted operations were performed.");
    });
    await prompt;
    expect(await server.rpc.workspace.readFile({ path: "protected.txt" })).toBe(
      "original",
    );
  },
);

serverTest(
  "accesses unrelated workspace threads through exec",
  async ({ server, llm }) => {
    const unrelated = await server.rpc.testApi.seedSession({
      title: "Shared report",
      messages: [
        { role: "user", content: "cobalt ibis", timestamp: Date.now() },
      ],
    });
    const caller = await server.rpc.thread.new();
    const prompt = server.promptAndWait({
      ...caller,
      text: "Inspect workspace threads",
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "threads",
        arguments: {
          js: `
      const created = await tools.thread.new({requestId: "independent-thread"});
      const retry = await tools.thread.new({requestId: "independent-thread"});
      const listed = await tools.thread.list({});
      const snapshot = await tools.thread.snapshot({threadId: ${JSON.stringify(unrelated.sessionId)}});
      return {created, retry, listed, snapshot};
    `,
        },
      }),
    );
    await llm.respond(({ messages }) => {
      const output = JSON.parse(
        messageText(
          messages.find(
            (message) =>
              message.role === "tool" && message.tool_call_id === "threads",
          )!,
        ),
      );
      expect(output.created).toMatchObject({
        ok: true,
        data: { threadId: expect.any(String) },
      });
      expect(output.retry).toEqual(output.created);
      expect(output.listed).toMatchObject({
        ok: true,
        data: expect.arrayContaining([
          expect.objectContaining({ threadId: unrelated.sessionId }),
        ]),
      });
      expect(output.snapshot.ok).toBe(true);
      expect(JSON.stringify(output.snapshot.data)).toContain("cobalt ibis");
      return m.assistant("Read the independent conversation.");
    });
    await prompt;
  },
);

serverTest(
  "thread tools preserve durable submissions, bounded waits, and explicit abort",
  async ({ server, llm }) => {
    const target = await server.rpc.thread.new();
    const input = {
      threadId: target.sessionId,
      requestId: "shared-message",
      text: "Answer the report",
    };
    const accepted = await server.rpc.testApi.invokeTool({
      path: "thread.prompt",
      input,
    });
    expect(accepted).toMatchObject({ submissionId: expect.any(Number) });
    expect(
      await server.rpc.testApi.invokeTool({ path: "thread.prompt", input }),
    ).toEqual(accepted);
    // SAFETY: The public tool response was checked for a numeric submissionId above.
    const waiting = {
      threadId: target.sessionId,
      ...(accepted as { submissionId: number }),
    };
    await llm.waitForRequest();
    expect(
      await server.rpc.testApi.invokeTool({
        path: "thread.wait",
        input: { ...waiting, timeoutMs: 10 },
      }),
    ).toEqual({ status: "pending" });
    expect(
      (await server.rpc.thread.list()).find(
        (thread) => thread.sessionId === target.sessionId,
      )?.isRunning,
    ).toBe(true);
    await expect(
      server.rpc.testApi.invokeTool(
        {
          path: "thread.wait",
          input: { ...waiting, timeoutMs: 30_000 },
        },
        { signal: AbortSignal.timeout(100) },
      ),
    ).rejects.toThrow();
    await llm.respond(m.assistant("The shared report is ready."));
    expect(
      await server.rpc.testApi.invokeTool({
        path: "thread.wait",
        input: waiting,
      }),
    ).toMatchObject({ status: "completed" });
    await server.stop();
    await server.start();
    expect(
      await server.rpc.testApi.invokeTool({ path: "thread.prompt", input }),
    ).toEqual(accepted);
    expect(
      await server.rpc.testApi.invokeTool({
        path: "thread.wait",
        input: waiting,
      }),
    ).toMatchObject({ status: "completed" });
    await expect(
      server.rpc.testApi.invokeTool({
        path: "thread.wait",
        input: { ...waiting, submissionId: 999999 },
      }),
    ).rejects.toThrow("Unknown thread submission");
    const next = await server.rpc.testApi.invokeTool({
      path: "thread.prompt",
      input: { ...input, requestId: "abort-message", text: "More work" },
    });
    expect(next).toMatchObject({ submissionId: expect.any(Number) });
    await llm.waitForRequest();
    await server.rpc.testApi.invokeTool({
      path: "thread.abort",
      input: { threadId: target.sessionId },
    });
    expect(
      await server.rpc.testApi.invokeTool({
        path: "thread.wait",
        input: {
          threadId: target.sessionId,
          // SAFETY: The prompt response was checked for a numeric submissionId above.
          ...(next as { submissionId: number }),
        },
      }),
    ).toMatchObject({ status: "aborted" });
    expect(
      sessionMessages(await server.rpc.thread.snapshot(target)).filter(
        (message) => message.role === "user",
      ),
    ).toHaveLength(2);
  },
);

serverTest(
  "thread tools enforce workspace grants without ownership rules",
  async ({ createServer }) => {
    const server = createServer({ agentCapabilities: [] });
    await server.start();
    const target = await server.rpc.thread.new();
    for (const operation of [
      { name: "list", input: {}, capability: "read" },
      {
        name: "snapshot",
        input: { threadId: target.sessionId },
        capability: "read",
      },
      {
        name: "wait",
        input: { threadId: target.sessionId, submissionId: 1 },
        capability: "read",
      },
      { name: "new", input: { requestId: "denied" }, capability: "write" },
      {
        name: "prompt",
        input: {
          threadId: target.sessionId,
          requestId: "denied",
          text: "Do not run",
        },
        capability: "write",
      },
      {
        name: "abort",
        input: { threadId: target.sessionId },
        capability: "write",
      },
    ]) {
      await expect(
        server.rpc.testApi.invokeTool({
          path: `thread.${operation.name}`,
          input: operation.input,
        }),
      ).rejects.toThrow(`workspace.threads.${operation.capability}`);
    }
    expect(await server.rpc.thread.list()).toHaveLength(1);
    expect(sessionMessages(await server.rpc.thread.snapshot(target))).toEqual(
      [],
    );
  },
);

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
    expect(await server.rpc.thread.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ...saved, title: "Saved notes" }),
      ]),
    );
    await server.stop();
    await server.start();

    const continued = server.promptAndWait({
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
    expect(assistantReplies(await server.rpc.thread.snapshot(saved))).toEqual([
      "Blue notebook → Continue",
    ]);
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
  session: Awaited<ReturnType<HaloClient["thread"]["snapshot"]>>,
) {
  return sessionMessages(session).flatMap((message) =>
    message.role === "assistant" ? [contentText(message.content)] : [],
  );
}

serverTest(
  "accepts a prompt before the provider responds and cancelling its waiter does not cancel work",
  async ({ server, llm }) => {
    const session = await server.rpc.thread.new();
    const controller = new AbortController();
    const accepted = await server.rpc.thread.prompt({
      ...session,
      text: "Keep going after I disconnect",
    });
    const waiting = server.rpc.thread.wait(
      { ...session, ...accepted },
      { signal: controller.signal },
    );
    const disconnected = expect(waiting).rejects.toThrow();
    await llm.waitForRequest();

    controller.abort();
    await disconnected;
    await llm.respond(m.assistant("I kept going."));

    await expect
      .poll(async () => await server.rpc.thread.snapshot(session))
      .toMatchObject({
        lastRun: { status: "completed" },
      });
    expect(assistantReplies(await server.rpc.thread.snapshot(session))).toEqual(
      ["I kept going."],
    );

    const continued = server.promptAndWait({
      ...session,
      text: "Thanks",
    });
    await llm.respond(m.assistant("You're welcome."));
    await continued;
    expect(assistantReplies(await server.rpc.thread.snapshot(session))).toEqual(
      ["I kept going.", "You're welcome."],
    );
  },
);

serverTest(
  "reconnects to a running conversation without losing or duplicating its answer",
  async ({ server, llm }) => {
    const session = await server.rpc.thread.new();
    const initial = new AbortController();
    const watch = await server.rpc.thread.events(session, {
      signal: initial.signal,
    });
    const first = await watch.next();
    expect(first.value).toMatchObject({
      type: "snapshot",
      snapshot: { entries: [] },
    });

    const prompted = server.promptAndWait({
      ...session,
      text: "Keep going while I reconnect",
    });
    await llm.waitForRequest();
    initial.abort();
    await watch.return();

    const reconnected = new AbortController();
    const updates = await server.rpc.thread.events(session, {
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
    expect(await server.rpc.thread.snapshot(session)).toMatchObject({
      entries: state.entries,
      lastRun: state.lastRun,
    });
  },
);

serverTest(
  "keeps large tool results searchable without sending them into model context",
  async ({ server, llm }) => {
    const fullText = `${"A".repeat(9_000)}\nneedle in the middle\n${"M".repeat(50_000)}\n${"Z".repeat(33_000)}`;
    await server.rpc.workspace.writeFile({
      path: "large.txt",
      content: fullText,
    });
    const session = await server.rpc.thread.new();
    const prompt = server.promptAndWait({
      ...session,
      text: "Find the needle",
    });
    await llm.respond(
      m.tool.start("read", {
        id: "read-large",
        arguments: { path: "large.txt" },
      }),
    );

    let outputFile = "";
    await llm.respond(({ messages }) => {
      const output = messageText(
        messages.findLast((item) => item.role === "tool")!,
      );
      expect(output).toContain("A".repeat(8_000));
      expect(output).toContain("Z".repeat(32_000));
      expect(output).not.toContain("needle in the middle");
      expect(output.length).toBeLessThan(41_000);
      const match = output.match(/Full output: (.*?)\. Search that file/);
      assert(match !== null);
      outputFile = match[1]!;
      return m.tool.start("bash", {
        id: "search-large",
        arguments: { command: `rg -n 'needle' '${outputFile}'` },
      });
    });
    expect(await fs.readFile(outputFile, "utf8")).toBe(fullText);

    await llm.respond(({ messages }) => {
      const output = messageText(
        messages.findLast((item) => item.role === "tool")!,
      );
      expect(output).toContain("needle in the middle");
      return m.tool.start("bash", {
        id: "reread-large",
        arguments: { command: `cat '${outputFile}'` },
      });
    });
    await llm.respond(({ messages }) => {
      const output = messageText(
        messages.findLast((item) => item.role === "tool")!,
      );
      expect(output).toContain("characters omitted from the middle");
      expect(output).not.toContain("needle in the middle");
      expect(output.length).toBeLessThan(41_000);
      return m.assistant("Found the needle.");
    });
    await prompt;
  },
);

serverTest(
  "preserves the full result when exec returns a large value",
  async ({ server, llm }) => {
    const session = await server.rpc.thread.new();
    const prompt = server.promptAndWait({
      ...session,
      text: "Return a large value",
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "exec-large",
        arguments: {
          js: 'return "A".repeat(9_000) + "needle in the middle" + "Z".repeat(33_000)',
        },
      }),
    );
    await llm.respond(async ({ messages }) => {
      const output = messageText(
        messages.findLast((item) => item.role === "tool")!,
      );
      expect(output).toContain("A".repeat(8_000));
      expect(output).toContain("Z".repeat(32_000));
      expect(output).not.toContain("needle in the middle");
      expect(output.length).toBeLessThan(41_000);
      const match = output.match(/Full output: (.*?)\. Search that file/);
      assert(match !== null);
      expect(await fs.readFile(match[1]!, "utf8")).toBe(
        `${"A".repeat(9_000)}needle in the middle${"Z".repeat(33_000)}`,
      );
      return m.assistant("Done.");
    });
    await prompt;
  },
);

serverTest(
  "keeps a bounded preview when saving a large tool result fails",
  async ({ server, llm }) => {
    const fullText = `${"A".repeat(9_000)}needle in the middle${"Z".repeat(33_000)}`;
    await server.rpc.workspace.writeFile({
      path: "large.txt",
      content: fullText,
    });
    const session = await server.rpc.thread.new();
    const outputDirectory = path.join(
      server.workspaceRoot,
      ".halo",
      "tool-outputs",
    );
    await fs.mkdir(outputDirectory, { recursive: true });
    await fs.writeFile(
      path.join(outputDirectory, session.sessionId),
      "blocked",
    );

    const prompt = server.promptAndWait({
      ...session,
      text: "Read large.txt",
    });
    await llm.respond(
      m.tool.start("read", {
        id: "read-large-save-failure",
        arguments: { path: "large.txt" },
      }),
    );
    await llm.respond(({ messages }) => {
      const output = messageText(
        messages.findLast((item) => item.role === "tool")!,
      );
      expect(output).toContain("A".repeat(8_000));
      expect(output).toContain("Z".repeat(32_000));
      expect(output).not.toContain("needle in the middle");
      expect(output).toContain("Full output could not be saved");
      expect(output.length).toBeLessThan(41_000);
      return m.assistant("Done.");
    });
    await prompt;
  },
);

serverTest(
  "streams large nested Bash output to a searchable file",
  async ({ server, llm }) => {
    const session = await server.rpc.thread.new();
    const prompt = server.promptAndWait({
      ...session,
      text: "Run a noisy command",
    });
    const command =
      "printf '%050000d' 0; printf '\\nneedle from stderr\\n' >&2";
    await llm.respond(
      m.tool.start("exec", {
        id: "nested-bash-large",
        arguments: {
          js: `return await tools.bash.run({ command: ${JSON.stringify(command)} });`,
        },
      }),
    );
    await llm.respond(async ({ messages }) => {
      const output = messageText(
        messages.findLast((item) => item.role === "tool")!,
      );
      expect(output.length).toBeLessThan(30_000);
      const match = output.match(/"fullOutputPath": "([^"]+)"/);
      assert(match !== null);
      const saved = await fs.readFile(match[1]!, "utf8");
      expect(saved.match(/0/g)).toHaveLength(50_000);
      expect(saved).toContain("needle from stderr");
      return m.assistant("Done.");
    });
    await prompt;
  },
);

serverTest(
  "writes Bash output to disk before the command exits",
  { timeout: 40_000 },
  async ({ server, llm }) => {
    const session = await server.rpc.thread.new();
    const prompt = server.promptAndWait({
      ...session,
      text: "Run a long command",
    });
    await llm.respond(
      m.tool.start("bash", {
        id: "stream-bash",
        arguments: {
          command:
            "printf '%050000d' 0; while [ ! -f bash-release ]; do sleep 0.05; done",
          timeoutMs: 30_000,
        },
      }),
    );

    const outputDirectory = path.join(
      server.workspaceRoot,
      ".halo",
      "tool-outputs",
      session.sessionId,
    );
    await expect
      .poll(async () => {
        const files = await fs.readdir(outputDirectory).catch(() => []);
        if (files.length === 0) return 0;
        return (await fs.stat(path.join(outputDirectory, files[0]!))).size;
      })
      .toBe(50_000);
    await server.rpc.workspace.writeFile({ path: "bash-release", content: "" });

    await llm.respond(({ messages }) => {
      const output = messageText(
        messages.findLast((item) => item.role === "tool")!,
      );
      expect(output).toContain("characters omitted from the middle");
      expect(output.length).toBeLessThan(41_000);
      return m.assistant("Done.");
    });
    await prompt;
  },
);

serverTest(
  "preserves every connection and approval requested by one exec",
  async ({ server, llm }) => {
    const session = await server.rpc.thread.new();
    const prompting = server.promptAndWait({
      ...session,
      text: "Connect Drive and Gmail and create two policies",
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "mixed-requests",
        arguments: {
          js: `return await Promise.allSettled([
        tools.halo.showConnectionCard({ integration: "google_drive" }),
        tools.executor.coreTools.policies.create({ owner: "user", pattern: "mixed-first.*", action: "block" }),
        tools.halo.showConnectionCard({ integration: "google_gmail" }),
        tools.executor.coreTools.policies.create({ owner: "user", pattern: "mixed-second.*", action: "block" })
      ]);`,
        },
      }),
    );
    await llm.respond(
      m.assistant("Please respond to the connection and approval cards."),
    );
    await prompting;
    const snapshot = await server.rpc.thread.snapshot(session);
    const executions = sessionToolExecutions(snapshot);
    expect(executions).toHaveLength(1);
    const execution = executions[0]!;
    assert(execution.type === "exec");
    expect(execution.approvals).toHaveLength(2);
    expect(execution.approvals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolPath: "executor.coreTools.policies.create",
          status: "pending",
          arguments: {
            owner: "user",
            pattern: "mixed-first.*",
            action: "block",
          },
        }),
        expect.objectContaining({
          toolPath: "executor.coreTools.policies.create",
          status: "pending",
          arguments: {
            owner: "user",
            pattern: "mixed-second.*",
            action: "block",
          },
        }),
      ]),
    );
    expect(execution.result?.details).toMatchObject({
      connectionRequests: [
        expect.objectContaining({ integration: "google_drive" }),
        expect.objectContaining({ integration: "google_gmail" }),
      ],
    });
    await server.rpc.thread.close(session);
    expect(
      sessionToolExecutions(await server.rpc.thread.snapshot(session)),
    ).toEqual(executions);
  },
);

serverTest(
  "finishes approval requests and retries only after a thread response",
  async ({ server, llm }) => {
    for (const decision of ["allow", "deny"] as const) {
      const session = await server.rpc.thread.new();
      const prompting = server.promptAndWait({
        ...session,
        text: `${decision} the policy`,
      });
      const js = `return await tools.executor.coreTools.policies.create({ owner: "user", pattern: "approval-test-${decision}.*", action: "block" });`;
      await llm.respond(
        m.tool.start("exec", {
          id: `approval-request-${decision}`,
          arguments: { js },
        }),
      );
      await llm.respond(m.assistant(`Waiting for ${decision}`));
      await prompting;
      const pending = await server.rpc.thread.snapshot(session);
      expect(pending.activeRun).toBeUndefined();
      const approval = sessionToolExecutions(pending).flatMap((execution) =>
        execution.type === "exec" ? execution.approvals : [],
      )[0]!;
      expect(approval.status).toBe("pending");

      await server.rpc.thread.respondToToolApproval({
        ...session,
        approvalId: approval.id,
        decision,
      });
      if (decision === "allow") {
        await llm.respond(
          m.tool.start("exec", {
            id: "approval-retry-allow",
            arguments: { js },
          }),
        );
      }
      await llm.respond(m.assistant(`${decision} finished`));

      await expect
        .poll(async () => {
          const snapshot = await server.rpc.thread.snapshot(session);
          return {
            activeRun: snapshot.activeRun,
            executions: sessionToolExecutions(snapshot),
          };
        })
        .toMatchObject({
          activeRun: undefined,
          executions:
            decision === "allow"
              ? [
                  {
                    approvals: [{ id: approval.id, status: "allowed" }],
                  },
                  { id: "approval-retry-allow", status: "completed" },
                ]
              : [
                  {
                    approvals: [{ id: approval.id, status: "denied" }],
                  },
                ],
        });
      const completed = await server.rpc.thread.snapshot(session);
      const executions = sessionToolExecutions(completed);
      expect(executions[0]).toMatchObject({
        type: "exec",
        status: "completed",
        approvals: [
          {
            id: approval.id,
            status: decision === "allow" ? "allowed" : "denied",
          },
        ],
      });
      expect(executions).toHaveLength(decision === "allow" ? 2 : 1);
      if (decision === "allow") {
        expect(executions[1]).toMatchObject({
          id: "approval-retry-allow",
          status: "completed",
          approvals: [],
        });
      }
      await server.rpc.thread.close(session);
      const restored = await server.rpc.thread.snapshot(session);
      expect(sessionToolExecutions(restored)).toEqual(executions);
      await expect(
        server.rpc.thread.respondToToolApproval({
          ...session,
          approvalId: approval.id,
          decision,
        }),
      ).rejects.toThrow("no longer pending");
    }
  },
);

serverTest(
  "keeps approval decisions when a busy continuation is aborted",
  async ({ server, llm }) => {
    for (const decision of ["allow", "deny"] as const) {
      const session = await server.rpc.thread.new();
      const prompting = server.promptAndWait({
        ...session,
        text: "Create a policy",
      });
      await llm.respond(
        m.tool.start("exec", {
          id: `pending-${decision}`,
          arguments: {
            js: `return await tools.executor.coreTools.policies.create({ owner: "user", pattern: "abort-${decision}.*", action: "block" });`,
          },
        }),
      );
      await llm.respond(m.assistant("Please respond to the approval card."));
      await prompting;
      const snapshot = await server.rpc.thread.snapshot(session);
      const approval = sessionToolExecutions(snapshot).flatMap((execution) =>
        execution.type === "exec" ? execution.approvals : [],
      )[0]!;
      const busy = await server.rpc.thread.prompt({
        ...session,
        text: "Work on something else",
      });
      await llm.waitForRequest();
      await server.rpc.thread.respondToToolApproval({
        ...session,
        approvalId: approval.id,
        decision,
      });
      await server.rpc.thread.abort(session);
      await server.rpc.thread.wait({
        ...session,
        submissionId: busy.submissionId,
      });
      const stopped = await server.rpc.thread.snapshot(session);
      expect(sessionToolExecutions(stopped)[0]).toMatchObject({
        approvals: [
          {
            id: approval.id,
            status: decision === "allow" ? "allowed" : "denied",
          },
        ],
      });
      await server.rpc.thread.close(session);
      const restored = await server.rpc.thread.snapshot(session);
      expect(sessionToolExecutions(restored)).toEqual(
        sessionToolExecutions(stopped),
      );
      await expect(
        server.rpc.thread.respondToToolApproval({
          ...session,
          approvalId: approval.id,
          decision,
        }),
      ).rejects.toThrow("no longer pending");
    }
  },
);

serverTest(
  "requires another approval when retry arguments change",
  async ({ server, llm }) => {
    const session = await server.rpc.thread.new();
    const originalJs =
      'return await tools.executor.coreTools.policies.create({ owner: "user", pattern: "approval-original.*", action: "block" });';
    const prompting = server.promptAndWait({
      ...session,
      text: "Create the policy",
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "approval-original",
        arguments: { js: originalJs },
      }),
    );
    await llm.respond(m.assistant("Waiting for approval"));
    await prompting;
    const pending = await server.rpc.thread.snapshot(session);
    const originalApproval = sessionToolExecutions(pending).flatMap(
      (execution) => (execution.type === "exec" ? execution.approvals : []),
    )[0]!;

    await server.rpc.thread.respondToToolApproval({
      ...session,
      approvalId: originalApproval.id,
      decision: "allow",
    });
    const changedJs =
      'return await tools.executor.coreTools.policies.create({ owner: "user", pattern: "approval-changed.*", action: "block" });';
    await llm.respond(
      m.tool.start("exec", {
        id: "approval-changed",
        arguments: { js: changedJs },
      }),
    );
    await llm.respond(m.assistant("The changed request needs approval"));

    await expect
      .poll(async () => {
        const snapshot = await server.rpc.thread.snapshot(session);
        return {
          activeRun: snapshot.activeRun,
          approvals: sessionToolExecutions(snapshot).flatMap((execution) =>
            execution.type === "exec" ? execution.approvals : [],
          ),
        };
      })
      .toMatchObject({
        activeRun: undefined,
        approvals: [
          { id: originalApproval.id, status: "allowed" },
          { status: "pending", arguments: { pattern: "approval-changed.*" } },
        ],
      });
    const completed = await server.rpc.thread.snapshot(session);
    const approvals = sessionToolExecutions(completed).flatMap((execution) =>
      execution.type === "exec" ? execution.approvals : [],
    );
    expect(approvals).toMatchObject([
      { id: originalApproval.id, status: "allowed" },
      { status: "pending", arguments: { pattern: "approval-changed.*" } },
    ]);
  },
);

serverTest(
  "exposes the same exec activity through live updates, snapshots, and server restart",
  async ({ server, llm, http }) => {
    await server.rpc.workspace.writeFile({
      path: "notes.md",
      content: "Saved notes",
    });
    const session = await server.rpc.thread.new();
    const controller = new AbortController();
    const watch = await server.rpc.thread.events(session, {
      signal: controller.signal,
    });
    const events: SessionEvent[] = [];
    let live = emptySessionSnapshot();
    const observed = (async () => {
      for await (const item of watch) {
        if (item.type === "event") events.push(item.event);
        live = reduceSessionUpdate(live, item);
        if (live.lastRun?.status === "completed") break;
      }
    })();

    const prompt = server.promptAndWait({
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
      .poll(async () => await server.rpc.thread.snapshot(session))
      .toEqual(live);
    const runId = live.activeRun!.id;

    request.respond("The report is ready.");
    await llm.waitForRequest();
    const waiting = await server.rpc.thread.snapshot(session);
    expect(waiting.activeRun).toBeDefined();
    expect(waiting.activeRun!.id).toBe(runId);
    expect(waiting.lastRun).toBeUndefined();
    await expect.poll(() => live).toEqual(waiting);
    await llm.respond(m.assistant("Finished the report."));
    await prompt;
    await observed;
    controller.abort();
    expect(events.filter((event) => event.type === "run.started")).toEqual([
      { type: "run.started", runId },
    ]);
    expect(events.filter((event) => event.type === "run.finished")).toEqual([
      { type: "run.finished", run: { id: runId, status: "completed" } },
    ]);
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
    expect(await server.rpc.thread.snapshot(session)).toEqual(live);
    expect(new Set(live.entries.map((entry) => entry.id)).size).toBe(
      live.entries.length,
    );

    await server.stop();
    await server.start();
    expect(await server.rpc.thread.snapshot(session)).toEqual(live);
  },
);

serverTest(
  "reopens a conversation after shutting down with a tool and viewer still active",
  { timeout: 20_000 },
  async ({ server, llm, http }) => {
    const session = await server.rpc.thread.new();
    const watch = await server.rpc.thread.events(session);
    await watch.next();
    const accepted = await server.rpc.thread.prompt({
      ...session,
      text: "Fetch the report",
    });
    const waiting = server.rpc.thread.wait({ ...session, ...accepted });
    const disconnected = expect(waiting).rejects.toThrow();
    const command = `printf x >> replay-count.txt; curl --silent --fail '${http.url("/pending-report")}'`;
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

    await llm.respond(({ messages }) => {
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            tool_call_id: "pending-report",
            content: expect.stringContaining("interrupted"),
          }),
        ]),
      );
      return m.assistant("The interrupted report was not rerun.");
    });
    await expect
      .poll(async () =>
        assistantReplies(await server.rpc.thread.snapshot(session)),
      )
      .toContain("The interrupted report was not rerun.");
    const restored = await server.rpc.thread.snapshot(session);
    expect(sessionMessages(restored)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Fetch the report" }),
      ]),
    );
    expect(restored.activeRun).toBeUndefined();
    expect(sessionToolExecutions(restored)).toMatchObject([
      { id: "pending-report", type: "exec", status: "failed" },
    ]);
    expect(
      await server.rpc.workspace.readFile({ path: "replay-count.txt" }),
    ).toBe("x");

    const continued = server.promptAndWait({
      ...session,
      text: "Continue without the report",
    });
    await llm.respond(m.assistant("Continuing without it."));
    await continued;
    await expect
      .poll(async () =>
        assistantReplies(await server.rpc.thread.snapshot(session)),
      )
      .toContain("Continuing without it.");
  },
);

serverTest(
  "kills nested bash.run after the default 10s timeout",
  { timeout: 25_000 },
  async ({ server, llm }) => {
    const session = await server.rpc.thread.new();
    const prompt = server.promptAndWait({
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
            await server.rpc.thread.snapshot(session),
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
    const updates = await server.rpc.thread.watchSummaries(undefined, {
      signal: first.signal,
    });
    expect((await updates.next()).value).toEqual({
      type: "snapshot",
      sessions: [],
    });
    const session = await server.rpc.thread.new();
    expect((await updates.next()).value).toMatchObject({
      type: "updated",
      session: {
        ...session,
        isRunning: false,
        markedDone: false,
      },
    });

    const prompting = server.promptAndWait({
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
      markedDone: false,
    });
    await llm.respond(m.assistant("First result"));
    await prompting;
    const completed = await nextSummary(
      updates,
      (summary) => !summary.isRunning && summary.latestResultId !== undefined,
    );
    expect(completed.latestResultId).toBeDefined();
    expect(completed).toMatchObject({ markedDone: false });
    expect(completed.readReceiptCursorId).toBeUndefined();
    expect(isThreadUnread(completed)).toBe(true);
    first.abort();

    // Finish another run while this client is disconnected.
    const again = server.promptAndWait({
      ...session,
      text: "Finish while I am disconnected",
    });
    await llm.respond(m.assistant("Second result"));
    await again;
    const reconnect = new AbortController();
    cleanup.defer(() => reconnect.abort());
    const resumed = await server.rpc.thread.watchSummaries(undefined, {
      signal: reconnect.signal,
    });
    const current = await resumed.next();
    expect(current.value).toMatchObject({
      type: "snapshot",
      sessions: [
        {
          ...session,
          isRunning: false,
          markedDone: false,
        },
      ],
    });
    if (current.done || current.value.type !== "snapshot")
      throw new Error("Expected summary snapshot");
    const readCursorId = current.value.sessions[0]!.latestResultId;
    expect(readCursorId).toBeDefined();
    expect(readCursorId).not.toBe(completed.latestResultId);
    expect(isThreadUnread(current.value.sessions[0]!)).toBe(true);

    // Aborting an active run also pushes its settled status.
    const aborted = server.promptAndWait({
      ...session,
      text: "Stop this run",
    });
    await nextSummary(resumed, (summary) => summary.isRunning);
    await llm.waitForRequest();
    await server.rpc.thread.abort(session);
    await aborted;
    const stopped = await nextSummary(
      resumed,
      (summary) =>
        !summary.isRunning && summary.latestResultId !== readCursorId,
    );
    expect(stopped.latestResultId).toBeDefined();
    reconnect.abort();
    await server.stop();
    await server.start();
    const restart = new AbortController();
    cleanup.defer(() => restart.abort());
    const restored = await server.rpc.thread.watchSummaries(undefined, {
      signal: restart.signal,
    });
    expect((await restored.next()).value).toMatchObject({
      type: "snapshot",
      sessions: [
        {
          ...session,
          isRunning: false,
          latestResultId: stopped.latestResultId,
          markedDone: false,
        },
      ],
    });
    restart.abort();
  },
);

serverTest(
  "persists session status commands and streams their summaries",
  async ({ server, llm }) => {
    using cleanup = new errore.DisposableStack();
    const firstConnection = new AbortController();
    cleanup.defer(() => firstConnection.abort());
    const updates = await server.rpc.thread.watchSummaries(undefined, {
      signal: firstConnection.signal,
    });
    await updates.next();
    const otherWindow = await server.rpc.thread.watchSummaries(undefined, {
      signal: firstConnection.signal,
    });
    await otherWindow.next();

    await expect(
      server.rpc.thread.markDone({ sessionId: "missing" }),
    ).rejects.toThrow();
    expect(await server.rpc.thread.list()).toEqual([]);

    const first = await server.rpc.thread.new();
    await nextSummary(
      updates,
      (summary) => summary.sessionId === first.sessionId,
    );
    const second = await server.rpc.thread.new();
    await nextSummary(
      updates,
      (summary) => summary.sessionId === second.sessionId,
    );
    await server.rpc.thread.markUnread(second);
    const secondSummary = (await server.rpc.thread.list()).find(
      (summary) => summary.sessionId === second.sessionId,
    );
    expect(secondSummary).toMatchObject({
      ...second,
      markedDone: false,
    });
    expect(secondSummary?.readReceiptCursorId).toBeUndefined();

    // A session without any transcript or product-state row can be marked done.
    await server.rpc.thread.markDone(second);
    expect(
      await nextSummary(
        updates,
        (summary) =>
          summary.sessionId === second.sessionId && summary.markedDone,
      ),
    ).toMatchObject({ ...second, markedDone: true });
    await server.rpc.thread.markUndone(second);
    await nextSummary(
      updates,
      (summary) =>
        summary.sessionId === second.sessionId && !summary.markedDone,
    );

    const prompted = server.promptAndWait({
      ...first,
      text: "Produce a result for status commands",
    });
    await nextSummary(
      updates,
      (summary) => summary.sessionId === first.sessionId && summary.isRunning,
    );
    await llm.respond(m.assistant("Completed result"));
    await prompted;
    const completed = await nextSummary(
      updates,
      (summary) =>
        summary.sessionId === first.sessionId && isThreadUnread(summary),
    );
    assert(completed.latestResultId !== undefined);

    await server.rpc.thread.markRead({
      ...first,
      observedResultId: completed.latestResultId,
    });
    const read = await nextSummary(
      updates,
      (summary) =>
        summary.sessionId === first.sessionId && !isThreadUnread(summary),
    );
    expect(read).toMatchObject({
      ...first,
      markedDone: false,
      readReceiptCursorId: read.latestResultId,
    });

    // Listing/reconnecting must not consume the update owed to existing watchers.
    await Promise.all([
      server.rpc.thread.markDone(first),
      server.rpc.thread.list(),
    ]);
    for (const stream of [updates, otherWindow]) {
      expect(
        await nextSummary(
          stream,
          (summary) =>
            summary.sessionId === first.sessionId && summary.markedDone,
        ),
      ).toMatchObject({
        markedDone: true,
        readReceiptCursorId: completed.latestResultId,
      });
    }

    await server.rpc.thread.markUnread(first);
    const unread = await nextSummary(
      updates,
      (summary) =>
        summary.sessionId === first.sessionId && isThreadUnread(summary),
    );
    expect(unread).toMatchObject({
      ...first,
      markedDone: true,
    });
    expect(unread.readReceiptCursorId).toBeUndefined();

    await server.rpc.thread.markUndone(first);
    await nextSummary(
      updates,
      (summary) => summary.sessionId === first.sessionId && !summary.markedDone,
    );

    const nextPrompt = server.promptAndWait({
      ...first,
      text: "Produce another result for status commands",
    });
    await nextSummary(
      updates,
      (summary) => summary.sessionId === first.sessionId && summary.isRunning,
    );
    await llm.respond(m.assistant("New completed result"));
    await nextPrompt;
    const nextCompleted = await nextSummary(
      updates,
      (summary) =>
        summary.sessionId === first.sessionId &&
        summary.latestResultId !== completed.latestResultId &&
        isThreadUnread(summary),
    );
    await server.rpc.thread.markRead({
      ...first,
      observedResultId: completed.latestResultId,
    });
    const afterStaleRead = (await server.rpc.thread.list()).find(
      (summary) => summary.sessionId === first.sessionId,
    );
    expect(afterStaleRead?.latestResultId).toBe(nextCompleted.latestResultId);
    expect(afterStaleRead?.readReceiptCursorId).toBeUndefined();
    assert(afterStaleRead !== undefined);
    expect(isThreadUnread(afterStaleRead)).toBe(true);

    await server.rpc.thread.markDone(first);
    const done = await nextSummary(
      updates,
      (summary) => summary.sessionId === first.sessionId && summary.markedDone,
    );
    expect(done).toMatchObject({
      ...first,
      markedDone: true,
    });
    expect(done.readReceiptCursorId).toBeUndefined();
    expect(isThreadUnread(done)).toBe(true);

    firstConnection.abort();
    await server.stop();
    await server.start();

    const secondConnection = new AbortController();
    cleanup.defer(() => secondConnection.abort());
    const restored = await server.rpc.thread.watchSummaries(undefined, {
      signal: secondConnection.signal,
    });
    const snapshot = await restored.next();
    if (snapshot.done || snapshot.value.type !== "snapshot")
      throw new Error("Expected restored session summary snapshot");
    const restoredFirst = snapshot.value.sessions.find(
      (summary) => summary.sessionId === first.sessionId,
    );
    expect(restoredFirst).toMatchObject({
      ...first,
      markedDone: true,
    });
    assert(restoredFirst !== undefined);
    expect(restoredFirst.readReceiptCursorId).toBeUndefined();
    expect(isThreadUnread(restoredFirst)).toBe(true);
    expect(
      snapshot.value.sessions.find(
        (summary) => summary.sessionId === second.sessionId,
      ),
    ).toMatchObject({
      ...second,
      markedDone: false,
    });

    assert(restoredFirst.latestResultId !== undefined);
    await server.rpc.thread.markRead({
      ...first,
      observedResultId: restoredFirst.latestResultId,
    });
    const restoredRead = await nextSummary(
      restored,
      (summary) =>
        summary.sessionId === first.sessionId && !isThreadUnread(summary),
    );
    expect(restoredRead).toMatchObject({
      markedDone: true,
      readReceiptCursorId: restoredRead.latestResultId,
    });

    await server.rpc.thread.markUndone(first);
    const restoredUndone = await nextSummary(
      restored,
      (summary) => summary.sessionId === first.sessionId && !summary.markedDone,
    );
    expect(restoredUndone).toMatchObject({
      markedDone: false,
      readReceiptCursorId: restoredUndone.latestResultId,
    });

    secondConnection.abort();
    await server.stop();
    await server.start();
    const final = await server.rpc.thread.list();
    const finalFirst = final.find(
      (summary) => summary.sessionId === first.sessionId,
    );
    assert(finalFirst !== undefined);
    expect(finalFirst).toMatchObject({
      markedDone: false,
      readReceiptCursorId: finalFirst.latestResultId,
    });
    expect(isThreadUnread(finalFirst)).toBe(false);
    expect(
      final.find((summary) => summary.sessionId === second.sessionId),
    ).toMatchObject({
      ...second,
      markedDone: false,
    });
  },
);

serverTest(
  "pushes named seeded sessions to every summary subscriber",
  async ({ server }) => {
    using cleanup = new errore.DisposableStack();
    const controller = new AbortController();
    cleanup.defer(() => controller.abort());
    const first = await server.rpc.thread.watchSummaries(undefined, {
      signal: controller.signal,
    });
    const second = await server.rpc.thread.watchSummaries(undefined, {
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
    const updates = await server.rpc.thread.watchSummaries(undefined, {
      signal: controller.signal,
    });
    await updates.next();
    const session = await server.rpc.thread.new();
    const prompted = server.promptAndWait({
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
    expect(await server.rpc.thread.snapshot(session)).toMatchObject({
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
    await using cleanup = new errore.AsyncDisposableStack();
    const db = new TandemClient({
      ...haloSchemaToTandemSchema(workspaceSchema),
      remote: createWorkspaceRemote({
        api: server.rendererRpc,
        signal: controller.signal,
        onDisconnect: console.warn,
      }),
      autoConnect: false,
    });
    cleanup.defer(async () => await db.disconnect());
    cleanup.defer(() => controller.abort());
    const updates: Hotkey[][] = [];
    const subscription = db.subscribe({ collection: "hotkeys" }, (records) =>
      updates.push(records),
    );
    cleanup.defer(subscription.destroy);
    await db.ready;
    await db.connect();
    expect(db.query({ collection: "hotkeys" })).toEqual([]);
    const session = await server.rpc.thread.new();
    const prompt = server.promptAndWait({
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
    await expect
      .poll(() => db.query({ collection: "hotkeys" }))
      .toMatchObject([hotkey]);
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
    await expect
      .poll(() => db.query({ collection: "hotkeys" }))
      .toMatchObject([changed]);
    await expect.poll(() => updates.at(-1)).toMatchObject([changed]);
    controller.abort();
    await db.disconnect();
    await server.stop();
    await server.start();
    expect(await server.rpc.hotkeys.list()).toEqual([changed]);
    const reconnectedController = new AbortController();
    const reconnected = new TandemClient({
      ...haloSchemaToTandemSchema(workspaceSchema),
      remote: createWorkspaceRemote({
        api: server.rendererRpc,
        signal: reconnectedController.signal,
        onDisconnect: console.warn,
      }),
      autoConnect: false,
    });
    cleanup.defer(async () => await reconnected.disconnect());
    cleanup.defer(() => reconnectedController.abort());
    const reconnectedSubscription = reconnected.subscribe(
      { collection: "hotkeys" },
      (records) => updates.push(records),
    );
    cleanup.defer(() => reconnectedSubscription.destroy());
    await reconnected.ready;
    await reconnected.connect();
    expect(reconnected.query({ collection: "hotkeys" })).toMatchObject([
      changed,
    ]);
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
    await expect
      .poll(() => reconnected.query({ collection: "hotkeys" }))
      .toEqual([]);
    reconnectedController.abort();
    await reconnected.disconnect();
    await server.stop();
    await server.start();
    expect(await server.rpc.hotkeys.list()).toEqual([]);
  },
);

serverTest(
  "preserves the gateway public origin for extension HTTP and WebSocket requests",
  async ({ createServer }) => {
    const gatewayToken = "test-workspace-gateway-token-0123456789";
    const server = createServer({ gateway: { token: gatewayToken } });
    await server.start();
    const directory = path.join(
      server.workspaceRoot,
      ".halo/extensions/origin-test",
    );
    const launcher = path.join(directory, "dist/start.mjs");
    await fs.mkdir(path.dirname(launcher), { recursive: true });
    await fs.writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "origin-test" }),
    );
    // A real extension process serves HTTP and accepts WebSocket upgrades.
    await fs.writeFile(
      launcher,
      `
      import http from "node:http";
      import crypto from "node:crypto";
      const server = http.createServer(async (request, response) => {
        response.setHeader("content-type", "application/json");
        if (request.url.endsWith("/threads")) {
          const result = await fetch(process.env.HALO_EXTENSION_TOOLS_ORIGIN + "/extension-tools/invoke", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer " + process.env.HALO_EXTENSION_TOOLS_TOKEN },
            body: JSON.stringify({ json: { path: "thread.list", input: {} } }),
          });
          response.writeHead(result.status);
          response.end(await result.text());
          return;
        }
        response.end(JSON.stringify(request.headers));
      });
      server.on("upgrade", (request, socket) => {
        const accept = crypto.createHash("sha1")
          .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");
        socket.end("HTTP/1.1 101 Switching Protocols\\r\\n" +
          "Connection: Upgrade\\r\\nUpgrade: websocket\\r\\n" +
          "Sec-WebSocket-Accept: " + accept + "\\r\\n" +
          "X-Origin-Host: " + request.headers["x-forwarded-host"] + "\\r\\n" +
          "X-Origin-Proto: " + request.headers["x-forwarded-proto"] + "\\r\\n\\r\\n");
      });
      server.listen(0, "127.0.0.1", () => {
        process.send("http://127.0.0.1:" + server.address().port + "/view/");
      });
      process.on("message", (message) => {
        if (message === "shutdown") server.close(() => process.exit(0));
      });
    `,
    );
    await server.rpc.extensions.reload();
    const url = `${server.transport.origin}/extensions/origin-test/view/`;
    const forwarded = {
      host: "private-vm.exe.xyz:8788",
      // Exe rewrites these to describe its own proxy hop.
      "x-forwarded-host": "private-vm.exe.xyz:8788",
      "x-forwarded-proto": "https",
      "x-halo-public-host": "halo.example:8443",
      "x-halo-public-proto": "https",
      cookie: "private-cookie",
      "x-exedev-authorization": "Bearer private-provider-token",
      "x-exedev-token-ctx": "private-token-context",
      "x-exedev-userid": "private-user",
      "x-exedev-email": "private@example.com",
    };
    const gatewayHeaders = {
      ...forwarded,
      authorization: `Bearer ${gatewayToken}`,
    };
    const independent = await server.rpc.thread.new();
    const threadsResponse = await fetch(`${url}threads`, {
      headers: gatewayHeaders,
    });
    expect(threadsResponse.status).toBe(200);
    expect(await threadsResponse.json()).toMatchObject({
      json: {
        ok: true,
        data: expect.arrayContaining([
          expect.objectContaining({ threadId: independent.sessionId }),
        ]),
      },
    });
    const response = await fetch(url, { headers: gatewayHeaders });
    expect(response.status).toBe(200);
    const received = await response.json();
    expect(received).toMatchObject({
      "x-forwarded-host": "halo.example:8443",
      "x-forwarded-proto": "https",
    });
    for (const name of [
      "authorization",
      "cookie",
      "x-halo-public-host",
      "x-halo-public-proto",
      "x-exedev-authorization",
      "x-exedev-token-ctx",
      "x-exedev-userid",
      "x-exedev-email",
    ])
      expect(received).not.toHaveProperty(name);

    const upgrade = await new Promise<nodeHttp.IncomingMessage>(
      (resolve, reject) => {
        const request = nodeHttp.request(url, {
          headers: {
            ...gatewayHeaders,
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          },
        });
        request.on("upgrade", (upgraded, socket) => {
          socket.destroy();
          resolve(upgraded);
        });
        request.on("response", (rejected) => {
          rejected.resume();
          reject(new Error(`Upgrade rejected: ${rejected.statusCode}`));
        });
        request.on("error", reject);
        request.end();
      },
    );
    expect(upgrade.statusCode).toBe(101);
    expect(upgrade.headers).toMatchObject({
      "x-origin-host": "halo.example:8443",
      "x-origin-proto": "https",
    });

    const direct = await fetch(url, {
      headers: { ...forwarded, ...server.transport.headers },
    });
    expect(direct.status).toBe(200);
    expect(await direct.json()).toMatchObject({
      "x-forwarded-host": new URL(server.transport.origin).host,
      "x-forwarded-proto": "http",
    });
  },
);

serverTest(
  "serializes hotkey conflicts and preserves save order across restart",
  async ({ server }) => {
    const outcomes = await Promise.allSettled([
      server.rpc.hotkeys.save({
        label: "First contender",
        accelerator: "Cmd+Shift+K",
        action: { type: "newTab" },
      }),
      server.rpc.hotkeys.save({
        label: "Second contender",
        accelerator: "Control+Shift+K",
        action: { type: "closeTab" },
      }),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(outcomes.filter((item) => item.status === "rejected")).toMatchObject(
      [{ reason: { message: expect.stringContaining("already assigned") } }],
    );
    const initial = await server.rpc.hotkeys.list();
    expect(initial).toHaveLength(1);
    const first = initial[0]!;
    const second = await server.rpc.hotkeys.save({
      label: "Open notes",
      accelerator: "Cmd+Shift+L",
      action: { type: "openFile", path: "notes.md" },
    });
    expect(await server.rpc.hotkeys.list()).toEqual([first, second]);
    const updated = await server.rpc.hotkeys.save({
      ...first,
      label: "Updated first",
    });
    expect(await server.rpc.hotkeys.list()).toEqual([second, updated]);
    await server.stop();
    await server.start();
    expect(await server.rpc.hotkeys.list()).toEqual([second, updated]);
    await server.rpc.hotkeys.remove({ id: second.id });
    expect(await server.rpc.hotkeys.list()).toEqual([updated]);
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

serverTest(
  "shares live workspace updates over one cancellable subscription",
  async ({ server }) => {
    using cleanup = new errore.DisposableStack();
    const controller = new AbortController();
    cleanup.defer(() => controller.abort());
    const updates = await server.rendererRpc.server.watch(undefined, {
      signal: controller.signal,
    });
    const initial = new Set<string>();
    while (initial.size < 2) {
      const next = await updates.next();
      assert(!next.done, "Workspace stream ended before initial snapshots");
      if (next.value.type === "files") continue;
      initial.add(next.value.type);
    }
    expect(initial).toEqual(new Set(["extensions", "sessions"]));
    const session = await server.rpc.thread.new();
    for await (const item of updates) {
      if (item.type !== "sessions") continue;
      expect(item.update).toMatchObject({
        type: "updated",
        session: { sessionId: session.sessionId },
      });
      break;
    }
    const reconnected = await server.rendererRpc.server.watch(undefined, {
      signal: controller.signal,
    });
    for await (const item of reconnected) {
      if (item.type !== "sessions") continue;
      expect(item.update).toMatchObject({
        type: "snapshot",
        sessions: [expect.objectContaining({ sessionId: session.sessionId })],
      });
      break;
    }
    // Leaving a for-await loop must cancel every source, including idle ones.
    await server.stop();
  },
);

serverTest(
  "rejects pre-Tandem protocols and unsupported writes",
  async ({ server }) => {
    const connected = await connectHaloClient({ transport: server.transport });
    assert(!(connected instanceof Error));
    expect(connected.serverInfo).toEqual({
      protocolVersion: haloProtocolVersion,
      supportedProtocols: haloSupportedProtocols,
    });
    for (const version of [18, 19, 21, 22, 23]) {
      const previousProtocol = createHaloClient({
        transport: {
          ...server.transport,
          headers: {
            ...server.transport.headers,
            "x-halo-protocol-version": String(version),
          },
        },
      });
      await expect(
        previousProtocol.workspace.writeFile({
          path: `legacy-${version}.md`,
          content: "Legacy client",
        }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_PROTOCOL" });
    }
    const previousStatusProtocol = createHaloClient({
      transport: {
        ...server.transport,
        headers: {
          ...server.transport.headers,
          "x-halo-protocol-version": "20",
        },
      },
    });
    await expect(previousStatusProtocol.thread.list()).rejects.toMatchObject({
      code: "UNSUPPORTED_PROTOCOL",
    });
    const unsupported = createHaloClient({
      transport: {
        ...server.transport,
        headers: {
          ...server.transport.headers,
          "x-halo-protocol-version": "999",
        },
      },
    });
    expect(await unsupported.server.info()).toMatchObject({
      supportedProtocols: haloSupportedProtocols,
    });
    await expect(
      unsupported.workspace.writeFile({
        path: "unsupported.md",
        content: "must not write",
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_PROTOCOL" });
    expect(await server.rpc.workspace.listPaths()).not.toContain(
      "unsupported.md",
    );
  },
);

serverTest(
  "merges independent note edits and uncontested deletions without inference",
  async ({ server }) => {
    const base =
      "# Plan\n\nMeet Tuesday at 2pm.\n\nRemove this paragraph.\n\nKeep this footer.\n";
    const local = base
      .replace("Tuesday", "Wednesday")
      .replace("Remove this paragraph.\n\n", "");
    const remote = base.replace("2pm", "3pm");
    await server.rpc.workspace.writeFile({ path: "plan.md", content: remote });
    const prepared = await server.rpc.workspace.reconcileNote({
      path: "plan.md",
      base,
      content: local,
    });
    expect(prepared.content).toBe(
      "# Plan\n\nMeet Wednesday at 3pm.\n\nKeep this footer.\n",
    );
    expect(
      await server.rpc.workspace.writeFile({ path: "plan.md", ...prepared }),
    ).toMatchObject({ conflict: false });
    expect(await server.rpc.workspace.readFile({ path: "plan.md" })).toBe(
      prepared.content,
    );
    const historyDirectory = path.join(
      server.workspaceRoot,
      ".halo",
      "note-history",
    );
    const records = await fs.readdir(historyDirectory);
    expect(records).toHaveLength(1);
    expect(
      JSON.parse(
        await fs.readFile(path.join(historyDirectory, records[0]!), "utf8"),
      ),
    ).toMatchObject({
      original: base,
      local,
      remote,
      resolved: prepared.content,
    });
    await server.stop();
    await server.start();
    expect(await server.rpc.workspace.readFile({ path: "plan.md" })).toBe(
      prepared.content,
    );
    expect(await fs.readdir(historyDirectory)).toEqual(records);
  },
);

serverTest(
  "resolves only overlapping note sections with document context",
  async ({ server, llm }) => {
    const prefix = "# Travel\n\nWe are arranging the team trip.\n\n";
    const suffix =
      "\nBudget is unchanged.\n\n" + "Unrelated private appendix.\n".repeat(10);
    const base = prefix + "Depart Tuesday.\n" + suffix;
    await server.rpc.workspace.writeFile({
      path: "trip.md",
      content: base.replace("Tuesday", "Thursday"),
    });
    const preparing = server.rpc.workspace.reconcileNote({
      path: "trip.md",
      base,
      content: base.replace("Tuesday", "Wednesday"),
    });
    await llm.respond(({ messages, tools }) => {
      const system = messages
        .filter(
          (message) =>
            message.role === "system" || message.role === "developer",
        )
        .map(messageText)
        .join("\n");
      expect(system).toContain("Halo's Markdown reconciliation assistant");
      expect(system).toContain("untrusted data");
      expect(system).toContain(
        "retain content so the person can delete it later",
      );
      expect(tools ?? []).toHaveLength(0);
      const user = messages.findLast((message) => message.role === "user")!;
      const request = JSON.parse(messageText(user));
      expect(request).toMatchObject({
        heading: "# Travel\n",
        original: "Depart Tuesday.\n",
        local: "Depart Wednesday.\n",
        remote: "Depart Thursday.\n",
      });
      expect(request.contextBefore).toContain("arranging the team trip");
      expect(request.contextAfter).toContain("Budget is unchanged");
      expect(messageText(user)).not.toContain(
        "Unrelated private appendix.\n".repeat(10),
      );
      return m.assistant(
        JSON.stringify({
          markdown: "Departure options: Wednesday or Thursday.",
        }),
      );
    });
    const prepared = await preparing;
    expect(prepared.content).toBe(
      prefix + "Departure options: Wednesday or Thursday.\n" + suffix,
    );
    await server.rpc.workspace.writeFile({ path: "trip.md", ...prepared });
    expect(await server.rpc.workspace.readFile({ path: "trip.md" })).toBe(
      prepared.content,
    );
  },
);

for (const response of [
  m.error("Provider unavailable"),
  m.assistant("not JSON"),
  m.assistant('{"markdown":""}'),
  m.assistant('{"markdown":"<<<<<<< local"}'),
]) {
  serverTest(
    `preserves both note alternatives when inference returns ${JSON.stringify(response)}`,
    async ({ server, llm }) => {
      await server.rpc.workspace.writeFile({
        path: "fallback.md",
        content: "# Heading\n\nServer detail.\n\nFooter.\n",
      });
      const preparing = server.rpc.workspace.reconcileNote({
        path: "fallback.md",
        base: "# Heading\n\nOriginal.\n\nFooter.\n",
        content: "# Heading\n\nLocal detail.\n\nFooter.\n",
      });
      await llm.respond(response);
      const prepared = await preparing;
      expect(prepared.content).toBe(
        "# Heading\n\nLocal detail.\n\nServer detail.\n\nFooter.\n",
      );
      await server.rpc.workspace.writeFile({
        path: "fallback.md",
        ...prepared,
      });
      expect(await server.rpc.workspace.readFile({ path: "fallback.md" })).toBe(
        prepared.content,
      );
    },
  );
}

serverTest(
  "rejects a stale note merge when the server changes during inference",
  async ({ server, llm }) => {
    await server.rpc.workspace.writeFile({
      path: "race.md",
      content: "Server version",
    });
    const preparing = server.rpc.workspace.reconcileNote({
      path: "race.md",
      base: "Original",
      content: "Local version",
    });
    await llm.waitForRequest();
    await server.rpc.testApi.invokeTool({
      path: "files.write",
      input: { path: "race.md", content: "Newer server version" },
    });
    await llm.respond(
      m.assistant(JSON.stringify({ markdown: "Local and server versions" })),
    );
    const prepared = await preparing;
    expect(
      await server.rpc.workspace.writeFile({ path: "race.md", ...prepared }),
    ).toMatchObject({ conflict: true });
    expect(await server.rpc.workspace.readFile({ path: "race.md" })).toBe(
      "Newer server version",
    );
  },
);

serverTest(
  "serializes competing conditional file saves and refuses deleted files",
  async ({ server }) => {
    await server.rpc.workspace.writeFile({
      path: "race.md",
      content: "Original",
    });
    const results = await Promise.all(
      ["One", "Two"].map(
        async (content) =>
          await server.rpc.workspace.writeFile({
            path: "race.md",
            content,
            expectedContent: "Original",
          }),
      ),
    );
    expect(results.filter((result) => result.conflict)).toHaveLength(1);
    const winner = results[0]!.conflict ? "Two" : "One";
    expect(await server.rpc.workspace.readFile({ path: "race.md" })).toBe(
      winner,
    );
    await server.rpc.workspace.deleteEntry({ path: "race.md" });
    await expect(
      server.rpc.workspace.writeFile({
        path: "race.md",
        content: "Stale",
        expectedContent: winner,
      }),
    ).rejects.toThrow();
    expect(await server.rpc.workspace.listPaths()).not.toContain("race.md");
  },
);

serverTest(
  "limits automatic reconciliation to Markdown and preserves identical edits",
  async ({ server }) => {
    await server.rpc.workspace.writeFile({
      path: "same.MD",
      content: "Same edit",
    });
    expect(
      await server.rpc.workspace.reconcileNote({
        path: "same.MD",
        base: "Original",
        content: "Same edit",
      }),
    ).toEqual({ content: "Same edit", expectedContent: "Same edit" });
    await server.rpc.workspace.writeFile({
      path: "code.ts",
      content: "remote",
    });
    await expect(
      server.rpc.workspace.reconcileNote({
        path: "code.ts",
        base: "base",
        content: "local",
      }),
    ).rejects.toThrow();
    expect(await server.rpc.workspace.readFile({ path: "code.ts" })).toBe(
      "remote",
    );
  },
);

serverTest(
  "preserves note paragraph boundaries when deletion conflicts with a revision and inference fails",
  async ({ server, llm }) => {
    const base = "# Notes\r\n\r\nBudget is $100.\r\n\r\nKeep this footer.\r\n";
    const remote = base.replace("$100", "$150 including delivery");
    await server.rpc.workspace.writeFile({
      path: "deletion.md",
      content: remote,
    });
    const preparing = server.rpc.workspace.reconcileNote({
      path: "deletion.md",
      base,
      content: "# Notes\r\n\r\nKeep this footer.\r\n",
    });
    await llm.respond(m.error("Rate limited"));
    const prepared = await preparing;
    expect(prepared.content).toBe(remote);
    await server.rpc.workspace.writeFile({ path: "deletion.md", ...prepared });
    expect(await server.rpc.workspace.readFile({ path: "deletion.md" })).toBe(
      remote,
    );
  },
);
