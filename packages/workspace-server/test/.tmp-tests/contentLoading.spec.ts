import { expect } from "vitest";
import { serverTest } from "../serverTest.js";
import {
  emptySessionSnapshot,
  reduceSessionUpdate,
  sessionMessages,
} from "@get-halo/client";
import { m } from "@get-halo/shared/testing";
import fs from "node:fs/promises";
import path from "node:path";

serverTest(
  "returns editable text in its preview without another file read",
  async ({ server }) => {
    for (const content of ["", "# Hello\n\nRésumé 🌍\n"]) {
      await server.rpc.workspace.writeFile({ path: "note.md", content });
      expect(
        await server.rpc.workspace.previewFile({ path: "note.md" }),
      ).toEqual({ kind: "text", content });
    }
    await fs.writeFile(
      path.join(server.workspaceRoot, "binary.bin"),
      Buffer.from([0, 255]),
    );
    expect(
      await server.rpc.workspace.previewFile({ path: "binary.bin" }),
    ).toMatchObject({ kind: "unsupported" });
    await fs.writeFile(
      path.join(server.workspaceRoot, "large.txt"),
      "x".repeat(5 * 1024 * 1024 + 1),
    );
    expect(
      await server.rpc.workspace.previewFile({ path: "large.txt" }),
    ).toMatchObject({ kind: "unsupported" });
  },
);

serverTest(
  "hands saved history over to live updates without losing a prompt",
  async ({ server, llm }) => {
    const session = await server.rpc.testApi.seedSession({
      title: "Cold history",
      messages: [
        { role: "user", content: "Earlier question", timestamp: Date.now() },
      ],
    });
    await server.stop();
    await server.start();
    const controller = new AbortController();
    const start = performance.now();
    const watch = await server.rpc.thread.events(session, {
      signal: controller.signal,
    });
    const first = await watch.next();
    const historyMs = performance.now() - start;
    expect(first.value).toMatchObject({
      type: "snapshot",
      snapshot: {
        entries: [
          { type: "message", message: { content: "Earlier question" } },
        ],
      },
    });
    if (first.done) throw new Error("Expected saved snapshot");
    let state = reduceSessionUpdate(emptySessionSnapshot(), first.value);
    const prompting = server.promptAndWait({
      ...session,
      text: "Continue now",
    });
    const second = await watch.next();
    const attachedMs = performance.now() - start;
    expect(second.value).toMatchObject({ type: "snapshot" });
    if (second.done) throw new Error("Expected live snapshot");
    state = reduceSessionUpdate(state, second.value);
    await llm.respond(m.assistant("Continued successfully"));
    await prompting;
    for await (const item of watch) {
      state = reduceSessionUpdate(state, item);
      if (state.lastRun?.status === "completed") break;
    }
    controller.abort();
    expect(sessionMessages(state).map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
    expect(state).toEqual(await server.rpc.thread.snapshot(session));
    console.log("SESSION_TIMINGS", { historyMs, attachedMs });
  },
);

serverTest(
  "reports a missing session instead of opening a runtime",
  async ({ server }) => {
    const watch = await server.rpc.thread.events({ sessionId: "missing" });
    await expect(watch.next()).rejects.toThrow();
  },
);

serverTest(
  "shows history while agent instructions are still loading",
  async ({ server }) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const session = await server.rpc.testApi.seedSession({
      title: "Blocked runtime",
      messages: [
        {
          role: "user",
          content: "Read this immediately",
          timestamp: Date.now(),
        },
      ],
    });
    const instructions = path.join(server.workspaceRoot, "AGENTS.md");
    await promisify(execFile)("mkfifo", [instructions]);
    let runtimeReleased = false;
    const release = setTimeout(() => {
      runtimeReleased = true;
      void fs.writeFile(instructions, "Instructions ready");
    }, 1000);
    const controller = new AbortController();
    const start = performance.now();
    const watch = await server.rpc.thread.events(session, {
      signal: controller.signal,
    });
    const first = await watch.next();
    const historyMs = performance.now() - start;
    const wasBlocked = !runtimeReleased;
    const second = await watch.next();
    clearTimeout(release);
    controller.abort();
    expect(first.value).toMatchObject({ type: "snapshot" });
    expect(second.value).toMatchObject({ type: "snapshot" });
    expect(wasBlocked).toBe(true);
    await fs.writeFile(
      path.resolve("../../tmp/loading-speed/session.json"),
      JSON.stringify({
        historyMs,
        runtimeDelayMs: 1000,
        historyBeforeRuntimeReady: wasBlocked,
      }),
    );
    await fs.unlink(instructions);
  },
);
