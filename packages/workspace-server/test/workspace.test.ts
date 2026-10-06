import * as errore from "errore";
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
import { assert, expect } from "vitest";
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
  "advertises protocol 24 and rejects unsupported writes",
  async ({ server }) => {
    const connected = await connectHaloClient({ transport: server.transport });
    assert(!(connected instanceof Error));
    expect(connected.serverInfo).toEqual({
      protocolVersion: haloProtocolVersion,
      supportedProtocols: [24],
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
      supportedProtocols: [24],
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
