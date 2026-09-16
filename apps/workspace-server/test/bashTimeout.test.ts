import {
  emptySessionSnapshot,
  reduceSessionUpdate,
  sessionToolExecutions,
  type SessionSnapshot,
} from "@get-halo/client";
import { expect } from "vitest";
import { m } from "@get-halo/shared/testing";
import type { LLMDriver } from "@get-halo/workspace-server/testing";
import { serverTest } from "./serverTest.js";
import type { TestServer } from "./TestServer.js";

serverTest(
  "runs nested bash without timeoutMs and prints ok",
  async ({ server, llm }) => {
    const snapshot = await runTool(server, llm, {
      name: "exec",
      id: "echo",
      arguments: {
        js: `return await tools.bash.run({ command: "echo ok" });`,
      },
    });
    expect(sessionToolExecutions(snapshot)).toMatchObject([
      { id: "echo", type: "exec", status: "completed" },
    ]);
    expect(toolOutputText(snapshot, "echo")).toContain("ok");
  },
);

serverTest("sets PAGER=cat for nested bash.run", async ({ server, llm }) => {
  const snapshot = await runTool(server, llm, {
    name: "exec",
    id: "pager",
    arguments: {
      js: `return await tools.bash.run({ command: 'printf %s "$PAGER"' });`,
    },
  });
  expect(toolOutputText(snapshot, "pager")).toContain("cat");
});

serverTest(
  "kills nested bash.run at an explicit timeoutMs",
  async ({ server, llm }) => {
    const started = Date.now();
    const snapshot = await runTool(server, llm, {
      name: "exec",
      id: "sleep",
      arguments: {
        js: `return await tools.bash.run({ command: "sleep 2", timeoutMs: 200 });`,
      },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(sessionToolExecutions(snapshot)).toMatchObject([
      { id: "sleep", type: "exec", status: "failed" },
    ]);
    expect(toolOutputText(snapshot, "sleep")).toContain("200");
  },
);

serverTest(
  "aborts nested bash.run before a long explicit timeout",
  async ({ server, llm }) => {
    const session = await server.rpc.sessions.create();
    const controller = new AbortController();
    const watch = await server.rpc.sessions.watch(session, {
      signal: controller.signal,
    });
    let live = emptySessionSnapshot();
    const observed = (async () => {
      for await (const item of watch) {
        live = reduceSessionUpdate(live, item);
        if (live.lastRun !== undefined && live.activeRun === undefined) break;
      }
    })();

    const prompt = server.rpc.sessions.prompt({
      ...session,
      text: "Run a long command",
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "long",
        arguments: {
          js: `return await tools.bash.run({ command: "sleep 30", timeoutMs: 60000 });`,
        },
      }),
    );
    await expect
      .poll(() => sessionToolExecutions(live))
      .toMatchObject([
        {
          id: "long",
          type: "exec",
          status: "running",
          calls: [{ tool: { path: "bash.run" }, status: "running" }],
        },
      ]);
    const started = Date.now();
    await server.rpc.sessions.abort(session);
    await prompt;
    await observed;
    controller.abort();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await server.rpc.sessions.snapshot(session)).toMatchObject({
      lastRun: { status: "aborted" },
    });
  },
);

serverTest(
  "runs top-level bash without timeout and prints ok",
  async ({ server, llm }) => {
    const snapshot = await runTool(server, llm, {
      name: "bash",
      id: "echo",
      arguments: { command: "echo ok" },
    });
    expect(sessionToolExecutions(snapshot)).toMatchObject([
      { id: "echo", type: "tool", status: "completed" },
    ]);
    expect(toolOutputText(snapshot, "echo")).toContain("ok");
  },
);

serverTest("sets PAGER=cat for top-level bash", async ({ server, llm }) => {
  const snapshot = await runTool(server, llm, {
    name: "bash",
    id: "pager",
    arguments: { command: 'printf %s "$PAGER"' },
  });
  expect(toolOutputText(snapshot, "pager")).toContain("cat");
});

serverTest(
  "kills top-level bash at an explicit timeout in seconds",
  async ({ server, llm }) => {
    const started = Date.now();
    const snapshot = await runTool(server, llm, {
      name: "bash",
      id: "sleep",
      arguments: { command: "sleep 2", timeout: 0.2 },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(sessionToolExecutions(snapshot)).toMatchObject([
      { id: "sleep", type: "tool", status: "failed" },
    ]);
    expect(toolOutputText(snapshot, "sleep")).toMatch(/timeout/i);
    expect(toolOutputText(snapshot, "sleep")).toContain("0.2");
  },
);

async function runTool(
  server: TestServer,
  llm: LLMDriver,
  tool: { name: string } & Parameters<typeof m.tool.start>[1],
) {
  const session = await server.rpc.sessions.create();
  const prompt = server.rpc.sessions.prompt({
    ...session,
    text: "Run the command",
  });
  await llm.respond(
    m.tool.start(tool.name, { id: tool.id, arguments: tool.arguments }),
  );
  await llm.respond(m.assistant("Done."));
  await prompt;
  return await server.rpc.sessions.snapshot(session);
}

function toolOutputText(snapshot: SessionSnapshot, id: string) {
  const execution = sessionToolExecutions(snapshot).find(
    (item) => item.id === id,
  );
  const content = execution?.result?.content;
  if (content === undefined) return "";
  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");
}
