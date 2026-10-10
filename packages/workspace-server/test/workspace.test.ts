import * as errore from "errore";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  createHaloClient,
  connectHaloClient,
  haloProtocolVersion,
  emptySessionSnapshot,
  isThreadUnread,
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
import { assert, expect, vi } from "vitest";
import { contentText } from "@earendil-works/pi-ai";
import { m } from "@get-halo/shared/testing";
import { messageText } from "@get-halo/workspace-server/testing";
import { serverTest } from "./serverTest.js";

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
  // Deletion is recursive, so the workspace root itself must be refused.
  await server.rpc.workspace.writeFile({ path: "keep.md", content: "Keep" });
  await expect(server.rpc.workspace.deleteEntry({ path: "" })).rejects.toThrow(
    "not a workspace file",
  );
  expect(await server.rpc.workspace.readFile({ path: "keep.md" })).toBe("Keep");
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
  "strips gateway credentials and preserves the public origin for extension requests",
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
    // A real extension process echoes the headers it receives.
    await fs.writeFile(
      launcher,
      `
      import http from "node:http";
      const server = http.createServer((request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(request.headers));
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

    // Without the gateway token, spoofed public-origin headers are ignored.
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

function assistantReplies(
  session: Awaited<ReturnType<HaloClient["thread"]["snapshot"]>>,
) {
  return sessionMessages(session).flatMap((message) =>
    message.role === "assistant" ? [contentText(message.content)] : [],
  );
}

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
  "lists connections and removes one only after the person approves",
  async ({ createServer, llm }) => {
    const removed: { integration: string; name: string }[] = [];
    const server = createServer({
      remoteConnections: {
        catalog: async () => [],
        startSetup: async () => new Error("unused"),
        setup: async () => new Error("unused"),
        cancelSetup: async () => undefined,
        connections: async () => [
          {
            address: "tools.google_gmail.user.personal",
            integration: "google_gmail",
            name: "personal",
            accountLabel: "me@example.com",
          },
        ],
        removeConnection: async (input) => {
          removed.push(input);
          return { revocation: "revoked" as const };
        },
      },
    });
    await server.start();
    const session = await server.rpc.thread.new();
    const prompting = server.promptAndWait({
      ...session,
      text: "Remove my personal Gmail",
    });
    const js = `const listed = await tools.halo.listConnections({});
const [connection] = listed.data.connections;
return await tools.halo.removeConnection({ integration: connection.integration, name: connection.name });`;
    await llm.respond(
      m.tool.start("exec", { id: "remove-request", arguments: { js } }),
    );
    await llm.respond(m.assistant("Approve the removal."));
    await prompting;
    const approval = sessionToolExecutions(
      await server.rpc.thread.snapshot(session),
    ).flatMap((execution) =>
      execution.type === "exec" ? execution.approvals : [],
    )[0]!;
    expect(approval).toMatchObject({
      status: "pending",
      toolPath: "halo.removeConnection",
      arguments: { integration: "google_gmail", name: "personal" },
    });
    expect(removed).toEqual([]);
    await server.rpc.thread.respondToToolApproval({
      ...session,
      approvalId: approval.id,
      decision: "allow",
    });
    await llm.respond(
      m.tool.start("exec", { id: "remove-retry", arguments: { js } }),
    );
    await llm.respond(m.assistant("Removed."));
    await expect
      .poll(async () =>
        sessionToolExecutions(await server.rpc.thread.snapshot(session)).find(
          (execution) => execution.id === "remove-retry",
        ),
      )
      .toMatchObject({
        status: "completed",
        result: {
          details: {
            status: "completed",
            result: { ok: true, data: { revocation: "revoked" } },
          },
        },
      });
    expect(removed).toEqual([
      { integration: "google_gmail", name: "personal" },
    ]);
  },
);

serverTest(
  "shows a remote setup card without per-action approval or a startup catalog",
  async ({ createServer, llm }) => {
    const setup = { cancelled: false };
    const server = createServer({
      remoteConnections: {
        catalog: async () => new Error("Control plane temporarily offline"),
        startSetup: async ({ integration }) => {
          expect(integration).toBe("new_mcp");
          return {
            setupId: "setup",
            setupUrl: "https://halo.example/integrations/setup/setup",
          };
        },
        setup: async () => ({
          status: setup.cancelled ? "cancelled" : "awaiting_credentials",
        }),
        connections: async () => [],
        removeConnection: async () => ({
          revocation: "not_supported" as const,
        }),
        cancelSetup: async () => {
          setup.cancelled = true;
        },
      },
    });
    await server.start();
    const session = await server.rpc.thread.new();
    const prompting = server.promptAndWait({
      ...session,
      text: "Connect the new MCP server",
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "remote-connection",
        arguments: {
          js: `return await Promise.allSettled([
            tools.halo.showConnectionCard({ integration: "new_mcp" }),
            tools.executor.coreTools.oauth.start({ client: "google", clientOwner: "org", owner: "user", name: "personal", integration: "google_gmail", template: "googleOAuth2" })
          ]);`,
        },
      }),
    );
    await llm.respond(m.assistant("Use the connection card to connect."));
    await prompting;
    const executions = sessionToolExecutions(
      await server.rpc.thread.snapshot(session),
    );
    expect(executions).toHaveLength(1);
    const execution = executions[0]!;
    assert(execution.type === "exec");
    expect(execution.approvals).toEqual([]);
    const request = { kind: "control-plane" as const, integration: "new_mcp" };
    expect(execution.result?.details).toMatchObject({
      connectionRequests: expect.arrayContaining([
        expect.objectContaining(request),
        expect.objectContaining({
          kind: "control-plane",
          integration: "google_gmail",
          connectionName: "personal",
        }),
      ]),
    });
    const started = await server.rpc.thread.startConnection({
      ...session,
      request,
    });
    expect(started).toMatchObject({
      status: "authorization-required",
      authorizationUrl: "https://halo.example/integrations/setup/setup",
    });
    if (started.status !== "authorization-required")
      throw new Error("Missing setup");
    await server.rpc.thread.cancelConnection({
      ...session,
      connectionId: started.connectionId,
    });
    expect(
      (await server.rpc.thread.snapshot(session)).connections,
    ).toMatchObject([{ request, status: "cancelled" }]);
  },
);

serverTest(
  "routes sandbox and extension integration tools while keeping local discovery offline",
  async ({ createServer, llm }) => {
    const address = "tools.custom.account.operation";
    const cancellation = { started: false, cancelled: false };
    let offline = false;
    let writes = 0;
    const schema = {
      address,
      integration: "custom",
      connection: "account",
      name: "Operation",
      description: "remote fixture",
      schemaDefinitions: { Shared: { type: "string" } },
      inputTypeScript: "{ value: string }",
    };
    const catalog = [schema];
    const server = createServer({
      remoteIntegrationTools: {
        search: async ({ limit }) =>
          offline
            ? new Error("offline")
            : {
                tools: catalog.slice(0, limit),
                truncated: limit !== undefined && catalog.length > limit,
              },
        describe: async ({ address: requested }) => {
          expect(requested).toBe(address);
          return schema;
        },
        invoke: async ({ address: requested, arguments: args }, signal) => {
          expect(requested).toBe(address);
          if (args.mode === "cancel") {
            cancellation.started = true;
            await new Promise<void>((resolve) => {
              signal!.addEventListener(
                "abort",
                () => {
                  cancellation.cancelled = true;
                  resolve();
                },
                { once: true },
              );
            });
            return {
              status: "failed",
              code: "outcome_unknown",
              message: "Cancelled",
            };
          }
          if (args.mode === "missing")
            return {
              status: "connection_required",
              integration: "custom",
              connectionName: "account",
            };
          if (args.mode === "lost") {
            writes++;
            return new Error("response lost after write");
          }
          return {
            status: "completed",
            result: { provider: "remote", arguments: args },
          };
        },
      },
    });
    await server.start();
    const session = await server.rpc.thread.new();
    const prompting = server.promptAndWait({
      ...session,
      text: "Use the remote fixture",
    });
    await fs.writeFile(
      path.join(server.workspaceRoot, "offline.txt"),
      "local offline data",
    );
    await llm.respond(
      m.tool.start("exec", {
        id: "remote-routing",
        arguments: {
          js: `
    const search = await tools.search({ query: "fixture", source: "control-plane" });
    if (!search.ok) throw new Error(JSON.stringify(search));
    const path = search.data.tools[0].path;
    const description = await tools.describe.tool({ path });
    const result = await tools[path]({ value: "sandbox" });
    const local = await tools.files.read({ path: "offline.txt" });
    return { search, description, result, local };
  `,
        },
      }),
    );
    await llm.respond(m.assistant("Done"));
    await prompting;
    const executions = sessionToolExecutions(
      await server.rpc.thread.snapshot(session),
    );
    expect(JSON.stringify(executions)).toContain("sandbox");
    expect(JSON.stringify(executions)).toContain("Shared");
    expect(JSON.stringify(executions)).toContain("local offline data");
    expect(JSON.stringify(executions)).toContain("{ value: string }");
    expect(JSON.stringify(executions)).toContain(`integrations.${address}`);
    const directory = path.join(
      server.workspaceRoot,
      ".halo/extensions/remote-routing",
    );
    await fs.mkdir(path.join(directory, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "remote-routing" }),
    );
    await fs.writeFile(
      path.join(directory, "dist/start.mjs"),
      `
    import http from "node:http";
    const server = http.createServer(async (request, response) => {
      const mode = request.url.split("/").at(-1);
      if (mode === "") { response.end("ready"); return; }
      const result = await fetch(process.env.HALO_EXTENSION_TOOLS_ORIGIN + "/extension-tools/invoke", {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.env.HALO_EXTENSION_TOOLS_TOKEN },
        body: JSON.stringify({ json: mode === "search" ? { path: "search", input: { query: "fixture", source: "control-plane" } } : mode === "describe" ? { path: "describe.tool", input: { path: ${JSON.stringify(`integrations.${address}`)} } } : { path: ${JSON.stringify(`integrations.${address}`)}, input: { mode } } }),
      });
      response.end(await result.text());
    });
    server.listen(0, "127.0.0.1", () => process.send("http://127.0.0.1:" + server.address().port + "/view/"));
    process.on("message", message => { if (message === "shutdown") server.close(() => process.exit(0)); });
  `,
    );
    await server.rpc.extensions.reload();
    const extension = async (mode: string) =>
      await fetch(
        `${server.transport.origin}/extensions/remote-routing/view/${mode}`,
        { headers: server.transport.headers },
      ).then(async (response) => await response.json());
    expect(await extension("success")).toMatchObject({
      json: { ok: true, data: { provider: "remote" } },
    });
    expect(await extension("missing")).toMatchObject({
      json: { ok: false, error: { code: "connection_required" } },
    });
    expect(await extension("search")).toMatchObject({
      json: {
        ok: true,
        data: { tools: [{ path: `integrations.${address}` }] },
      },
    });
    expect(await extension("lost")).toMatchObject({
      json: { ok: false, error: { code: "outcome_unknown" } },
    });
    expect(await extension("describe")).toMatchObject({
      json: {
        ok: true,
        data: {
          schemaDefinitions: schema.schemaDefinitions,
          inputTypeScript: schema.inputTypeScript,
        },
      },
    });
    catalog.push({
      ...schema,
      address: "tools.custom.account.added_after_startup",
    });
    expect(
      await server.rpc.testApi.invokeTool({
        path: "search",
        input: { query: "fixture", source: "control-plane" },
      }),
    ).toMatchObject({
      tools: [
        { path: `integrations.${address}` },
        { path: "integrations.tools.custom.account.added_after_startup" },
      ],
    });
    expect(
      await server.rpc.testApi.invokeTool({
        path: "search",
        input: { query: "fixture", source: "control-plane", limit: 1 },
      }),
    ).toMatchObject({
      tools: [{ path: `integrations.${address}` }],
      truncated: true,
    });
    expect(writes).toBe(1);
    expect(
      sessionToolExecutions(await server.rpc.thread.snapshot(session)),
    ).toEqual(executions);
    offline = true;
    expect(
      JSON.stringify(
        await server.rpc.testApi.invokeTool({
          path: "files.read",
          input: { path: "offline.txt" },
        }),
      ),
    ).toContain("local offline data");
    expect(
      await server.rpc.testApi.invokeTool({
        path: "search",
        input: { query: "read", source: "workspace" },
      }),
    ).toMatchObject({ unavailableSources: [] });
    expect(
      await server.rpc.testApi.invokeTool({
        path: "search",
        input: { query: "read" },
      }),
    ).toMatchObject({ unavailableSources: ["control-plane"] });
    expect(await extension("search")).toMatchObject({
      json: { ok: false, error: { code: "discovery_failed" } },
    });
    const collecting = server.promptAndWait({
      ...session,
      text: "Request the missing connection",
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "missing-connection",
        arguments: {
          js: `await tools[${JSON.stringify(`integrations.${address}`)}]({ mode: "missing" }); await tools[${JSON.stringify(`integrations.${address}`)}]({ mode: "missing" });`,
        },
      }),
    );
    await llm.respond(m.assistant("Connect using the card"));
    await collecting;
    const latest = sessionToolExecutions(
      await server.rpc.thread.snapshot(session),
    ).at(-1)!;
    assert(latest.type === "exec");
    expect(latest.approvals).toEqual([]);
    expect(latest.result?.details).toMatchObject({
      connectionRequests: [
        {
          kind: "control-plane",
          integration: "custom",
          connectionName: "account",
        },
      ],
    });
    const controller = new AbortController();
    const cancelling = server.rpc.testApi.invokeTool(
      {
        path: `integrations.${address}`,
        input: { mode: "cancel" },
      },
      { signal: controller.signal },
    );
    const rejected = expect(cancelling).rejects.toBeDefined();
    await vi.waitFor(() => expect(cancellation.started).toBe(true));
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(cancellation.cancelled).toBe(true));
    await server.stop();
    await server.start();
    expect(
      await server.rpc.testApi.invokeTool({
        path: `integrations.${address}`,
        input: { value: "saved path" },
      }),
    ).toMatchObject({ provider: "remote", arguments: { value: "saved path" } });
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
  "advertises protocols 25 and 26 and rejects unsupported writes",
  async ({ server }) => {
    const connected = await connectHaloClient({ transport: server.transport });
    assert(!(connected instanceof Error));
    expect(connected.serverInfo).toEqual({
      protocolVersion: haloProtocolVersion,
      supportedProtocols: [25, 26],
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
      supportedProtocols: [25, 26],
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
  "preserves both note alternatives when inference returns an empty merge",
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
    await llm.respond(m.assistant('{"markdown":""}'));
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
  "released protocol 25 clients can connect new and saved integration cards",
  async ({ createServer, llm }) => {
    let status: "authorizing" | "ready" | "failed" = "authorizing";
    const requested: { integration: string; connectionName?: string }[] = [];
    const server = createServer({
      remoteConnections: {
        catalog: async () => [{ integration: "example", name: "Example" }],
        startSetup: async (input) => {
          requested.push(input);
          return {
            setupId: "setup",
            setupUrl: "https://halo.example/integrations/setup/setup",
          };
        },
        setup: async () => ({ status }),
        connections: async () => [],
        removeConnection: async () => ({
          revocation: "not_supported" as const,
        }),
        cancelSetup: async () => undefined,
      },
    });
    await server.start();
    const legacy = createHaloClient({
      transport: {
        ...server.transport,
        headers: {
          ...server.transport.headers,
          "x-halo-protocol-version": "25",
        },
      },
    });
    const session = await legacy.thread.new();
    const prompting = server.promptAndWait({
      ...session,
      text: "Connect Example",
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "legacy-card",
        arguments: {
          js: 'await tools.halo.showConnectionCard({ integration: "example" });',
        },
      }),
    );
    await llm.respond(m.assistant("Connect Example using this card."));
    await prompting;
    const execution = sessionToolExecutions(
      await legacy.thread.snapshot(session),
    )[0]!;
    assert(execution.type === "exec");
    // Freeze the request schema validated by Halo 0.1.65 renderer and desktop IPC.
    const legacyRequestSchema = Type.Object({
      client: Type.String(),
      clientOwner: Type.Union([Type.Literal("org"), Type.Literal("user")]),
      owner: Type.Union([Type.Literal("org"), Type.Literal("user")]),
      connectionName: Type.String(),
      integration: Type.String(),
      template: Type.String(),
    });
    const details = execution.result?.details;
    assert(
      Value.Check(
        Type.Object({ connectionRequests: Type.Array(legacyRequestSchema) }),
        details,
      ),
    );
    const request = details.connectionRequests[0];
    assert(request !== undefined);
    const completion = {
      kind: "client-loopback" as const,
      redirectUri: "http://127.0.0.1:49152/oauth/callback",
    };
    const started = await legacy.thread.startConnection({
      ...session,
      request,
      completion,
    });
    expect(started).toMatchObject({
      status: "authorization-required",
      authorizationUrl: "https://halo.example/integrations/setup/setup",
    });
    status = "ready";
    await llm.respond(m.assistant("Example is connected."));
    await expect
      .poll(async () => (await legacy.thread.snapshot(session)).connections)
      .toMatchObject([{ request, status: "connected" }]);
    // Old desktop's unused callback timeout cannot cancel a completed setup.
    assert(started.status === "authorization-required");
    await legacy.thread.cancelConnection({
      ...session,
      connectionId: started.connectionId,
    });
    expect((await legacy.thread.snapshot(session)).connections).toMatchObject([
      { status: "connected" },
    ]);
    status = "failed";
    const savedRequest = {
      client: "google",
      clientOwner: "org" as const,
      owner: "user" as const,
      connectionName: "personal",
      integration: "example",
      template: "googleOAuth2",
    };
    const failed = await legacy.thread.startConnection({
      ...session,
      request: savedRequest,
      completion,
    });
    assert(failed.status === "authorization-required");
    await expect
      .poll(
        async () =>
          (await legacy.thread.snapshot(session)).connections.find(
            (connection) => connection.connectionId === failed.connectionId,
          )?.status,
      )
      .toBe("cancelled");
    // An unnamed card adds a connection instead of reconnecting "default".
    expect(requested).toEqual([
      { integration: "example", connectionName: undefined },
      { integration: "example", connectionName: "personal" },
    ]);
    await expect(
      legacy.thread.completeOAuth({
        state: "old-workspace-attempt",
        code: "old-code",
      }),
    ).rejects.toThrow("Connect again");
  },
);
