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
  type SessionSummary,
  type SessionSummariesUpdate,
} from "@get-halo/client";
import fs from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { assert, expect } from "vitest";
import { contentText } from "@earendil-works/pi-ai";
import { m } from "@get-halo/shared/testing";
import { messageText } from "@get-halo/workspace-server/testing";
import { serverTest } from "./serverTest.js";
import { TandemClient } from "@tanishqkancharla/tandem-core";
import { haloSchemaToTandemSchema } from "@get-halo/client";

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

serverTest(
  "searches reference paths with bounded, file-only results",
  async ({ server }) => {
    for (let index = 0; index < 10; index++) {
      await server.harness.files.write({
        path: path.join(server.workspaceRoot, "notes", `Report-${index}.md`),
        content: "report",
      });
    }
    await server.harness.files.write({
      path: path.join(server.workspaceRoot, "elsewhere", "unique.txt"),
      content: "unique",
    });
    expect(await server.rpc.workspace.searchPaths({ query: "REPORT" })).toEqual(
      Array.from({ length: 8 }, (_, index) => `notes/Report-${index}.md`),
    );
    expect(await server.rpc.workspace.searchPaths({ query: "unique" })).toEqual(
      ["elsewhere/unique.txt"],
    );
    expect(
      await server.rpc.workspace.searchPaths({ query: "missing" }),
    ).toEqual([]);
  },
);

serverTest(
  "streams only requested directory listings and refreshes after deletion",
  async ({ server }) => {
    const setupEvents = await server.rpc.workspace.events();
    await server.harness.files.write({
      path: path.join(server.workspaceRoot, "open", "nested", "hidden.txt"),
      content: "deep",
    });
    await server.harness.files.write({
      path: path.join(server.workspaceRoot, "closed", "other.txt"),
      content: "other",
    });
    for await (const events of setupEvents) {
      if (events.some((event) => event.path === "closed/other.txt")) break;
    }
    const controller = new AbortController();
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => controller.abort());
    const listings = await server.rendererRpc.workspace.watchDirectories(
      { paths: ["", "open", "open"] },
      { signal: controller.signal },
    );
    expect((await listings.next()).value).toEqual({
      path: "",
      entries: ["closed/", "open/"],
    });
    expect((await listings.next()).value).toEqual({
      path: "open",
      entries: ["open/nested/"],
    });
    await server.harness.files.write({
      path: path.join(server.workspaceRoot, "closed", "ignored.txt"),
      content: "ignored",
    });
    await server.harness.files.write({
      path: path.join(server.workspaceRoot, "open", "nested", "ignored.txt"),
      content: "ignored",
    });
    await server.harness.files.write({
      path: path.join(server.workspaceRoot, "open", "visible.txt"),
      content: "visible",
    });
    expect((await listings.next()).value).toEqual({
      path: "open",
      entries: ["open/nested/", "open/visible.txt"],
    });
    await server.rpc.workspace.deleteEntry({ path: "open/nested" });
    expect((await listings.next()).value).toEqual({
      path: "open",
      entries: ["open/visible.txt"],
    });
    const invalid = await server.rendererRpc.workspace.watchDirectories(
      { paths: ["../", ".halo", "open/visible.txt", "open"] },
      { signal: controller.signal },
    );
    for (const invalidPath of ["../", ".halo", "open/visible.txt"]) {
      expect((await invalid.next()).value).toEqual({
        path: invalidPath,
        entries: [],
        error: expect.stringContaining("not a workspace file"),
      });
    }
    expect((await invalid.next()).value).toEqual({
      path: "open",
      entries: ["open/visible.txt"],
    });
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
