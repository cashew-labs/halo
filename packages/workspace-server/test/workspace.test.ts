import * as errore from "errore";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  createHaloClient,
  createWorkspaceRemote,
  workspaceSchema,
  connectHaloClient,
  haloProtocolVersion,
  haloSupportedProtocols,
  emptyThreadSnapshot,
  isThreadUnread,
  reduceThreadUpdate,
  threadMessages,
  threadToolExecutions,
  type HaloClient,
  type Hotkey,
  type TraceRecord,
  type ThreadSummary,
  type ThreadSummariesUpdate,
} from "@get-halo/client";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { gunzipSync } from "node:zlib";
import { assert, expect, vi } from "vitest";
import { contentText } from "@earendil-works/pi-ai";
import { m } from "@get-halo/shared/testing";
import { messageText } from "@get-halo/workspace-server/testing";
import { haloTool } from "@get-halo/workspace-server";
import { serverTest } from "./serverTest.js";
import { TandemClient } from "@tanishqkancharla/tandem-core";
import { haloSchemaToTandemSchema } from "@get-halo/client";

serverTest(
  "requires a namespace for every Halo tool",
  async ({ createServer }) => {
    const server = createServer({
      tools: {
        // @ts-expect-error A root key must contain a HaloTools group, not a leaf.
        erase: haloTool({
          description: "Erase a file.",
          inputSchema: Type.Object({ path: Type.String() }),
          requiredCapabilities: [],
          execute: async () => ({ result: "erased" }),
        }),
      },
    });
    await expect(server.start()).rejects.toThrow("requires a namespace");
  },
);

serverTest(
  "derives deep exec paths and model aliases from one Halo tool tree",
  async ({ createServer, llm }) => {
    const inspectNote = haloTool({
      description: "Inspect a note with an identifying prefix.",
      inputSchema: Type.Object({ prefix: Type.String({ minLength: 2 }) }),
      requiredCapabilities: ["workspace.files.read"],
      execute: async ({ prefix }, ctx) => {
        const text = await ctx.services.filesystem.readFile(
          path.join(ctx.workspaceRoot, "note.txt"),
          "utf8",
        );
        if (text instanceof Error) return text;
        return {
          result: {
            text: `${prefix}:${text}`,
            threadId: ctx.threadId,
            modelId: ctx.modelId,
            userId: ctx.userId,
            toolPath: ctx.toolPath,
          },
          modelResult: {
            content: [{ type: "text", text: `${prefix}:${text}` }],
          },
        };
      },
      modelTool: {
        name: "inspectNote",
        replay: "safe",
      },
    });
    const server = createServer({
      tools: {
        notes: {
          org: { main: { inspect: inspectNote } },
          user: {
            named: {
              deep: { inspect: { ...inspectNote, modelTool: undefined } },
            },
          },
          locked: {
            ...inspectNote,
            requiredCapabilities: ["custom.denied"],
            modelTool: { ...inspectNote.modelTool!, name: "lockedNote" },
          },
        },
        numbers: {
          ping: haloTool({
            description: "Return the input number plus eleven.",
            inputSchema: Type.Object({ value: Type.Number() }),
            requiredCapabilities: [],
            execute: async ({ value }) => ({ result: value + 11 }),
          }),
        },
      },
    });
    await server.start();
    await server.rpc.workspace.writeFile({
      path: "note.txt",
      content: "delta",
    });
    const thread = await server.rpc.thread.new();
    const prompt = server.promptAndWait({
      ...thread,
      text: "Inspect through both surfaces",
    });
    await llm.respond(({ tools }) => {
      expect(
        tools?.map((entry) =>
          entry.type === "function" ? entry.function.name : "",
        ),
      ).toEqual(["inspectNote", "lockedNote", "exec"]);
      expect(tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            function: expect.objectContaining({
              name: "inspectNote",
              parameters: expect.objectContaining({
                properties: { prefix: { type: "string", minLength: 2 } },
              }),
            }),
          }),
        ]),
      );
      return [
        m.tool.start("inspectNote", {
          id: "alias",
          arguments: { prefix: "native" },
        }),
        m.tool.start("lockedNote", {
          id: "denied-alias",
          arguments: { prefix: "locked" },
        }),
        m.tool.start("exec", {
          id: "nested",
          arguments: {
            js: `({
            deep: await tools.notes.org.main.inspect({ prefix: "exec" }),
            deeper: await tools.notes.user.named.deep.inspect({ prefix: "hidden" }),
            number: await tools.numbers.ping({ value: 7 }),
            description: await tools.describe.tool({ path: "notes.org.main.inspect" }),
            numberDescription: await tools.describe.tool({ path: "numbers.ping" }),
            search: await tools.search({ query: "identifying prefix", source: "workspace" }),
            denied: await tools.notes.locked({ prefix: "locked" }),
            invalidDenied: await tools.notes.locked({ prefix: "x" }),
            invalid: await tools.notes.org.main.inspect({ prefix: "x" }),
            hostServicesVisible: typeof services !== "undefined"
          })`,
          },
        }),
      ];
    });
    await llm.respond(({ messages }) => {
      const output = (toolCallId: string) =>
        messageText(
          messages.find(
            (message) =>
              message.role === "tool" && message.tool_call_id === toolCallId,
          )!,
        );
      expect(output("alias")).toBe("native:delta");
      expect(output("denied-alias")).toContain(
        'Agent capability "custom.denied" is not granted',
      );
      const result = JSON.parse(output("nested"));
      expect(result).toMatchObject({
        deep: {
          ok: true,
          data: {
            text: "exec:delta",
            threadId: thread.sessionId,
            modelId: "scripted",
            userId: "server-test-user",
            toolPath: "notes.org.main.inspect",
          },
        },
        deeper: {
          ok: true,
          data: {
            text: "hidden:delta",
            toolPath: "notes.user.named.deep.inspect",
          },
        },
        number: { ok: true, data: 18 },
        description: {
          ok: true,
          data: {
            path: "notes.org.main.inspect",
            inputSchema: {
              properties: { prefix: { type: "string", minLength: 2 } },
            },
          },
        },
        numberDescription: { ok: true, data: { path: "numbers.ping" } },
        denied: { ok: false, error: { code: "AgentCapabilityDeniedError" } },
        invalidDenied: {
          ok: false,
          error: { code: "invalid_tool_arguments" },
        },
        invalid: {
          ok: false,
          error: {
            code: "invalid_tool_arguments",
            message: "Tool arguments did not match the input schema.",
            details: {
              issues: [
                {
                  path: ["prefix"],
                  message: "Expected string length greater or equal to 2",
                },
              ],
            },
          },
        },
        hostServicesVisible: false,
      });
      expect(
        result.search.data.tools.map((entry: { path: string }) => entry.path),
      ).toEqual([
        "notes.locked",
        "notes.org.main.inspect",
        "notes.user.named.deep.inspect",
      ]);
      return m.assistant("Inspected.");
    });
    await prompt;
    expect(
      threadToolExecutions(await server.rpc.thread.snapshot(thread)).find(
        (execution) => execution.id === "alias",
      )?.result?.details,
    ).toBeUndefined();
  },
);

serverTest.for([
  {
    name: "default JSON output",
    presentation: {},
    expectedText: '{\n  "answer": 23,\n  "raw": "private data"\n}',
    expectedDetails: { answer: 23, raw: "private data" },
    expectedIsError: false,
  },
  {
    name: "custom error content and redacted details",
    presentation: {
      modelResult: {
        content: [{ type: "text" as const, text: "Twenty-three." }],
        details: { answer: 23 },
        isError: true,
      },
    },
    expectedText: "Twenty-three.",
    expectedDetails: { answer: 23 },
    expectedIsError: true,
  },
  {
    name: "explicit JSON null details",
    presentation: {
      modelResult: {
        content: [{ type: "text" as const, text: "Twenty-three." }],
        // oxlint-disable-next-line unicorn/no-null -- Null is an explicit JSON metadata value.
        details: null,
      },
    },
    expectedText: "Twenty-three.",
    // oxlint-disable-next-line unicorn/no-null -- The protocol must preserve JSON null.
    expectedDetails: null,
    expectedIsError: false,
  },
])(
  "keeps exec data separate from $name",
  async (
    { presentation, expectedText, expectedDetails, expectedIsError },
    { createServer, llm },
  ) => {
    const server = createServer({
      tools: {
        answers: {
          inspect: haloTool({
            description: "Return an answer and optional model presentation.",
            inputSchema: Type.Object({}),
            requiredCapabilities: [],
            execute: async () => ({
              result: { answer: 23, raw: "private data" },
              ...presentation,
            }),
            modelTool: { name: "inspect", replay: "safe" },
          }),
        },
      },
    });
    await server.start();
    const thread = await server.rpc.thread.new();
    const prompt = server.promptAndWait({
      ...thread,
      text: "Inspect both outputs",
    });
    await llm.respond([
      m.tool.start("inspect", { id: "native", arguments: {} }),
      m.tool.start("exec", {
        id: "script",
        arguments: { js: "await tools.answers.inspect({})" },
      }),
    ]);
    await llm.respond(({ messages }) => {
      const output = (toolCallId: string) =>
        messageText(
          messages.find(
            (message) =>
              message.role === "tool" && message.tool_call_id === toolCallId,
          )!,
        );
      expect(output("native")).toBe(expectedText);
      expect(JSON.parse(output("script"))).toEqual({
        ok: true,
        data: { answer: 23, raw: "private data" },
      });
      return m.assistant("Inspected.");
    });
    await prompt;
    const native = threadToolExecutions(
      await server.rpc.thread.snapshot(thread),
    ).find((execution) => execution.id === "native");
    expect(native?.result?.details).toEqual(expectedDetails);
    expect(native?.status).toBe(expectedIsError ? "failed" : "completed");
  },
);

serverTest.for([
  {
    name: "void",
    result: () => undefined,
    expectedText: /^undefined$/,
  },
  {
    name: "BigInt",
    result: () => 23n,
    expectedText: /^23n$/,
  },
  {
    name: "cyclic object",
    result: () => {
      const value = { answer: 23 };
      return Object.assign(value, { self: value });
    },
    expectedText: /answer: 23[\s\S]*Circular/,
  },
])(
  "presents a successful native $name result without invalid metadata",
  async ({ result, expectedText }, { createServer, llm }) => {
    const server = createServer({
      tools: {
        answers: {
          inspect: haloTool({
            description: "Return a native result that is not JSON.",
            inputSchema: Type.Object({}),
            requiredCapabilities: [],
            execute: async () => ({ result: result() }),
            modelTool: { name: "inspect", replay: "safe" },
          }),
        },
      },
    });
    await server.start();
    const thread = await server.rpc.thread.new();
    const prompt = server.promptAndWait({
      ...thread,
      text: "Inspect the result",
    });
    await llm.respond(m.tool.start("inspect", { id: "native", arguments: {} }));
    await llm.respond(({ messages }) => {
      const output = messages.find(
        (message) =>
          message.role === "tool" && message.tool_call_id === "native",
      )!;
      expect(messageText(output)).toMatch(expectedText);
      return m.assistant("Inspected.");
    });
    await prompt;
    const native = threadToolExecutions(
      await server.rpc.thread.snapshot(thread),
    ).find((execution) => execution.id === "native");
    expect(native?.status).toBe("completed");
    expect(native?.result?.details).toBeUndefined();
    await server.rpc.thread.close(thread);
    const restored = threadToolExecutions(
      await server.rpc.thread.snapshot(thread),
    ).find((execution) => execution.id === "native");
    expect(restored).toEqual(native);
  },
);

serverTest(
  "rejects colliding model names before registering Halo tools",
  async ({ createServer }) => {
    const tool = haloTool({
      description: "Return a marker.",
      inputSchema: Type.Object({}),
      requiredCapabilities: [],
      execute: async () => ({ result: "marker" }),
      modelTool: { name: "inspect", replay: "safe" },
    });
    const server = createServer({
      tools: { first: { inspect: tool }, second: { inspect: tool } },
    });
    await expect(server.start()).rejects.toThrow(
      "duplicate model tool name inspect",
    );
  },
);

serverTest(
  "emits image references into model content without guest bytes or next-run leakage",
  async ({ server, llm }) => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVR4nGP4z8DwnwGM/zMwAAAf7gP9NRsAMwAAAABJRU5ErkJggg==";
    const imagePath = ".halo/computer/images/observation.png";
    await fs.mkdir(path.dirname(path.join(server.workspaceRoot, imagePath)), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(server.workspaceRoot, imagePath),
      Buffer.from(png, "base64"),
    );
    const thread = await server.rpc.thread.new();
    const prompt = server.promptAndWait({
      ...thread,
      text: "Inspect the observation",
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "emit-observation",
        arguments: {
          js: `var observation = { data: { text: "Desktop observation", screenshot: { path: ${JSON.stringify(imagePath)} } } }; console.log(observation.data.text); viewImage(observation.data.screenshot)`,
        },
      }),
    );
    await llm.respond(({ messages }) => {
      expect(
        messages
          .filter((message) => message.role === "tool")
          .map((message) => message.content)
          .join("\n"),
      ).toContain("Logs:\nDesktop observation");
      const images = messages.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.filter((part) => part.type === "image_url")
          : [],
      );
      expect(images).toHaveLength(1);
      expect(images[0]).toMatchObject({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${png}` },
      });
      const text = messages
        .filter((message) => message.role === "tool")
        .map((message) => message.content)
        .join("\n");
      expect(text).toContain("Desktop observation");
      expect(text).not.toContain(png);
      expect(text).not.toContain("data:image");
      return m.tool.start("exec", {
        id: "invalid-image",
        arguments: {
          js: 'viewImage({ path: "missing-image.png" }); viewImage({ path: 42 }); "still running"',
        },
      });
    });
    await llm.respond(({ messages }) => {
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "invalid-image",
          content: expect.stringContaining("could not read the file"),
        }),
      );
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "invalid-image",
          content: expect.stringContaining(
            "viewImage expects { path: string }",
          ),
        }),
      );
      const images = messages.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.filter((part) => part.type === "image_url")
          : [],
      );
      expect(images).toHaveLength(1);
      return m.tool.start("exec", {
        id: "await-image",
        arguments: {
          js: `console.log(await viewImage({ path: ${JSON.stringify(imagePath)} })); typeof observation`,
        },
      });
    });
    await llm.respond(({ messages }) => {
      const images = messages.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.filter((part) => part.type === "image_url")
          : [],
      );
      expect(images).toHaveLength(2);
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "await-image",
          content: expect.stringContaining('"ok":true'),
        }),
      );
      return m.tool.start("exec", {
        id: "bounded-images",
        arguments: {
          js: `for (var index = 0; index < 9; index++) viewImage({ path: ${JSON.stringify(imagePath)} }); "bounded"`,
        },
      });
    });
    await llm.respond(({ messages }) => {
      const images = messages.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.filter((part) => part.type === "image_url")
          : [],
      );
      expect(images).toHaveLength(10);
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "bounded-images",
          content: expect.stringContaining("At most 8 images"),
        }),
      );
      return m.tool.start("exec", {
        id: "same-thread-clean",
        arguments: { js: '"clean"' },
      });
    });
    await llm.respond(({ messages }) => {
      const images = messages.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.filter((part) => part.type === "image_url")
          : [],
      );
      expect(images).toHaveLength(10);
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "same-thread-clean",
          content: "clean",
        }),
      );
      return m.assistant("Viewed");
    });
    await prompt;
    const executions = threadToolExecutions(
      await server.rpc.thread.snapshot(thread),
    );
    const details = executions.map((execution) => execution.result?.details);
    expect(JSON.stringify(details)).not.toContain(png);
    expect(JSON.stringify(details)).not.toContain('"mimeType"');
    const other = await server.rpc.thread.new();
    const next = server.promptAndWait({
      ...other,
      text: "Start without images",
    });
    await llm.respond(
      m.tool.start("exec", { id: "no-image", arguments: { js: '"clean"' } }),
    );
    await llm.respond(({ messages }) => {
      const images = messages.flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.filter((part) => part.type === "image_url")
          : [],
      );
      expect(images).toHaveLength(0);
      return m.assistant("Clean");
    });
    await next;
  },
);

serverTest(
  "retains exec bindings outside the repository, resets explicitly, and notifies after reload",
  async ({ server, llm }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const workingDirectory = process.cwd();
    cleanup.defer(() => process.chdir(workingDirectory));
    // Production starts outside the source tree and its node_modules.
    process.chdir(os.tmpdir());
    const thread = await server.rpc.thread.new();
    const first = server.promptAndWait({
      ...thread,
      text: "Remember a number",
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "remember",
        arguments: { js: "var count = 17; count" },
      }),
    );
    for (const [index, js] of ["1n", "Symbol('x')", "(() => 7)"].entries()) {
      await llm.respond(
        m.tool.start("exec", {
          id: `unserializable-${index}`,
          arguments: { js },
        }),
      );
      await llm.respond(({ messages }) => {
        expect(messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "tool",
              tool_call_id: `unserializable-${index}`,
              content:
                index === 2
                  ? "() => 7"
                  : expect.stringContaining("bindings were retained"),
            }),
          ]),
        );
        return m.tool.start("exec", {
          id: `normalized-${index}`,
          arguments: { js: "({ count, method() {} })" },
        });
      });
      await llm.respond(({ messages }) => {
        expect(messages).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: "tool",
              tool_call_id: `normalized-${index}`,
              content: JSON.stringify({ count: 17 }, undefined, 2),
            }),
          ]),
        );
        return m.tool.start("exec", {
          id: `retained-${index}`,
          arguments: { js: "count" },
        });
      });
    }
    await llm.respond(({ messages }) => {
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            tool_call_id: "retained-2",
            content: "17",
          }),
        ]),
      );
      return m.assistant("Remembered");
    });
    await first;

    const next = server.promptAndWait({ ...thread, text: "Increase it" });
    await llm.respond(
      m.tool.start("exec", {
        id: "increase",
        arguments: { js: "count += 6; count" },
      }),
    );
    await llm.respond(({ messages }) => {
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            tool_call_id: "increase",
            content: "23",
          }),
        ]),
      );
      return m.tool.start("exec", { id: "reset", arguments: { op: "reset" } });
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "after-reset",
        arguments: { js: "typeof count" },
      }),
    );
    await llm.respond(({ messages }) => {
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            tool_call_id: "after-reset",
            content: "undefined",
          }),
        ]),
      );
      return m.assistant("Reset");
    });
    await next;
    await server.stop();
    await server.start();
    expect(
      (await server.rpc.thread.snapshot(thread)).activeRun,
    ).toBeUndefined();
    const resumed = server.promptAndWait({ ...thread, text: "Continue" });
    await llm.respond(({ messages }) => {
      expect(
        messages.filter(
          (message) =>
            message.content ===
            "Your exec JavaScript session was reset when this thread unloaded or the server restarted. Previous variables and functions are unavailable. External actions and workspace files were not rolled back.",
        ),
      ).toHaveLength(1);
      return m.tool.start("exec", {
        id: "after-reload",
        arguments: { js: "typeof count" },
      });
    });
    await llm.respond(({ messages }) => {
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            tool_call_id: "after-reload",
            content: "undefined",
          }),
        ]),
      );
      return m.assistant("Fresh session");
    });
    await resumed;
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
  "continues each thread with its own history and system prompt ID after restarting the server",
  async ({ server, llm }) => {
    const notebook = await server.rpc.thread.new();
    const saveNotebook = server.promptAndWait({
      ...notebook,
      text: "Blue notebook",
    });
    await llm.respond(({ messages }) => {
      const system = messages
        .filter((message) => message.role === "system")
        .map((message) => messageText(message))
        .join("\n");
      expect(system).toContain(`Current thread ID: ${notebook.sessionId}`);
      return m.assistant("Saved the notebook.");
    });
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
    await llm.respond(({ messages }) => {
      const system = messages
        .filter((message) => message.role === "system")
        .map((message) => messageText(message))
        .join("\n");
      expect(system).toContain(`Current thread ID: ${notebook.sessionId}`);
      expect(system).not.toContain(`Current thread ID: ${bicycle.sessionId}`);
      return m.assistant(
        messages
          .filter((message) => message.role === "user")
          .map((message) => messageText(message))
          .join(" → "),
      );
    });
    await recallNotebook;
    expect(
      assistantReplies(await server.rpc.thread.snapshot(notebook)),
    ).toEqual(["Saved the notebook.", "Blue notebook → Continue"]);

    const recallBicycle = server.promptAndWait({
      ...bicycle,
      text: "Continue",
    });
    await llm.respond(({ messages }) => {
      const system = messages
        .filter((message) => message.role === "system")
        .map((message) => messageText(message))
        .join("\n");
      expect(system).toContain(`Current thread ID: ${bicycle.sessionId}`);
      expect(system).not.toContain(`Current thread ID: ${notebook.sessionId}`);
      return m.assistant(
        messages
          .filter((message) => message.role === "user")
          .map((message) => messageText(message))
          .join(" → "),
      );
    });
    await recallBicycle;
    expect(assistantReplies(await server.rpc.thread.snapshot(bicycle))).toEqual(
      ["Saved the bicycle.", "Red bicycle → Continue"],
    );
  },
);

serverTest(
  "deduplicates thread and prompt request IDs and resumes waiting after restart",
  async ({ server, llm }) => {
    const [thread, retry] = await Promise.all([
      server.rpc.thread.new({ requestId: "durable-thread" }),
      server.rpc.thread.new({ requestId: "durable-thread" }),
    ]);
    expect(retry).toEqual(thread);
    expect(
      await server.rpc.thread.new({ requestId: "different-thread" }),
    ).not.toEqual(thread);
    const input = {
      ...thread,
      text: "Remember this once",
      clientMessageId: "durable-retry",
    };
    const accepted = await server.rpc.thread.prompt(input);
    const waiting = server.rpc.thread.wait({ ...thread, ...accepted });
    const disconnected = expect(waiting).rejects.toThrow();
    await llm.waitForRequest();
    await server.stop();
    await disconnected;
    await server.start();
    expect(
      await server.rpc.thread.new({ requestId: "durable-thread" }),
    ).toEqual(thread);
    await llm.respond(m.assistant("Remembered once."));
    await expect
      .poll(async () =>
        assistantReplies(await server.rpc.thread.snapshot(thread)),
      )
      .toEqual(["Remembered once."]);
    expect(await server.rpc.thread.prompt(input)).toEqual(accepted);
    await server.rpc.thread.wait({ ...thread, ...accepted });
    const settled = await server.rpc.thread.snapshot(thread);
    expect(
      threadMessages(settled).filter((message) => message.role === "user"),
    ).toHaveLength(1);
    await server.stop();
    await server.start();
    expect(await server.rpc.thread.prompt(input)).toEqual(accepted);
    await server.rpc.thread.wait({ ...thread, ...accepted });
    expect(await server.rpc.thread.snapshot(thread)).toEqual(settled);
  },
);

serverTest(
  "keeps full chat history when Durable compacts model context",
  async ({ server, llm }) => {
    const old = "Old context. ".repeat(45_000);
    const recent = "Recent context. ".repeat(6_500);
    const thread = await server.rpc.testApi.seedThread({
      title: "Long conversation",
      messages: [
        { role: "user", content: old, timestamp: Date.now() },
        { role: "user", content: recent, timestamp: Date.now() },
      ],
    });
    const prompting = server.promptAndWait({
      ...thread,
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
    const snapshot = await server.rpc.thread.snapshot(thread);
    expect(
      threadMessages(snapshot)
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual([old, recent, "Continue after compaction"]);
    expect(assistantReplies(snapshot)).toEqual([
      "Continued with compact context.",
    ]);
    await server.stop();
    await server.start();
    expect(await server.rpc.thread.snapshot(thread)).toEqual(snapshot);
  },
);

serverTest(
  "reopens a conversation after shutting down with a tool and viewer still active",
  { timeout: 20_000 },
  async ({ server, llm, http }) => {
    const thread = await server.rpc.thread.new();
    const watch = await server.rpc.thread.events(thread);
    await watch.next();
    const accepted = await server.rpc.thread.prompt({
      ...thread,
      text: "Fetch the report",
    });
    const waiting = server.rpc.thread.wait({ ...thread, ...accepted });
    const disconnected = expect(waiting).rejects.toThrow();
    const command = `printf x >> replay-count.txt; curl --silent --fail '${http.url("/pending-report")}'`;
    await llm.respond(
      m.tool.start("exec", {
        id: "pending-report",
        arguments: {
          js: `await tools.bash.run({ command: ${JSON.stringify(command)} });`,
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
        assistantReplies(await server.rpc.thread.snapshot(thread)),
      )
      .toContain("The interrupted report was not rerun.");
    const restored = await server.rpc.thread.snapshot(thread);
    expect(threadMessages(restored)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Fetch the report" }),
      ]),
    );
    expect(restored.activeRun).toBeUndefined();
    expect(threadToolExecutions(restored)).toMatchObject([
      { id: "pending-report", type: "exec", status: "failed" },
    ]);
    expect(
      await server.rpc.workspace.readFile({ path: "replay-count.txt" }),
    ).toBe("x");

    const continued = server.promptAndWait({
      ...thread,
      text: "Continue without the report",
    });
    await llm.respond(m.assistant("Continuing without it."));
    await continued;
    await expect
      .poll(async () =>
        assistantReplies(await server.rpc.thread.snapshot(thread)),
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
      const thread = await server.rpc.thread.new();
      const file = `${surface}.txt`;
      const prompt = server.promptAndWait({
        ...thread,
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
                    js: `await tools.${operation.path}(${JSON.stringify(operation.args)});`,
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
    const thread = await server.rpc.thread.new();
    const prompt = server.promptAndWait({
      ...thread,
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
    await llm.respond([
      ...operations.flatMap((operation) => [
        m.tool.start(operation.name, {
          id: `direct-${operation.name}`,
          arguments: operation.args,
        }),
        m.tool.start("exec", {
          id: `exec-${operation.name}`,
          arguments: {
            js: `await tools.${operation.path}(${JSON.stringify(operation.args)});`,
          },
        }),
      ]),
      m.tool.start("exec", {
        id: "denied-image",
        arguments: { js: 'await viewImage({ path: "protected.txt" })' },
      }),
    ]);
    await llm.respond(({ messages }) => {
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "denied-image",
          content: expect.stringContaining("workspace.files.read"),
        }),
      );
      expect(
        messages.flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.filter((part) => part.type === "image_url")
            : [],
        ),
      ).toHaveLength(0);
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
      server.rpc.testApi.seedThread({
        title: "Should not seed",
        messages: [],
      }),
    ).rejects.toThrow("The test API is disabled for this workspace server.");
    await expect(
      server.rpc.testApi.seedSession({
        title: "Should not seed through the legacy alias",
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
  thread: Awaited<ReturnType<HaloClient["thread"]["snapshot"]>>,
) {
  return threadMessages(thread).flatMap((message) =>
    message.role === "assistant" ? [contentText(message.content)] : [],
  );
}

serverTest(
  "reconnects to a running conversation without losing or duplicating its answer",
  async ({ server, llm }) => {
    const thread = await server.rpc.thread.new();
    const initial = new AbortController();
    const watch = await server.rpc.thread.events(thread, {
      signal: initial.signal,
    });
    const first = await watch.next();
    expect(first.value).toMatchObject({
      type: "snapshot",
      snapshot: { entries: [] },
    });

    const prompted = server.promptAndWait({
      ...thread,
      text: "Keep going while I reconnect",
    });
    await llm.waitForRequest();
    initial.abort();
    await watch.return();

    const reconnected = new AbortController();
    const updates = await server.rpc.thread.events(thread, {
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
    let state = emptyThreadSnapshot();
    if (current.done) throw new Error("Expected a thread snapshot");
    state = reduceThreadUpdate(state, current.value);
    for await (const item of updates) {
      state = reduceThreadUpdate(state, item);
      if (state.activeRun === undefined) {
        reconnected.abort();
        break;
      }
    }
    expect(
      threadMessages(state).flatMap((message) =>
        "content" in message ? [contentText(message.content)] : [],
      ),
    ).toEqual(["Keep going while I reconnect", "I kept going."]);
    expect(await server.rpc.thread.snapshot(thread)).toMatchObject({
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
    const thread = await server.rpc.thread.new();
    const prompt = server.promptAndWait({
      ...thread,
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
    const thread = await server.rpc.thread.new();
    const prompting = server.promptAndWait({
      ...thread,
      text: "Remove my personal Gmail",
    });
    const js = `var listed = await tools.halo.listConnections({});
var [connection] = listed.data.connections;
await tools.halo.removeConnection({ integration: connection.integration, name: connection.name });`;
    await llm.respond(
      m.tool.start("exec", { id: "remove-request", arguments: { js } }),
    );
    await llm.respond(m.assistant("Approve the removal."));
    await prompting;
    const approval = threadToolExecutions(
      await server.rpc.thread.snapshot(thread),
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
      ...thread,
      approvalId: approval.id,
      decision: "allow",
    });
    await llm.respond(
      m.tool.start("exec", { id: "remove-retry", arguments: { js } }),
    );
    await llm.respond(m.assistant("Removed."));
    await expect
      .poll(async () =>
        threadToolExecutions(await server.rpc.thread.snapshot(thread)).find(
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
  "filters the remote integration catalog without confusing misses and outages",
  async ({ createServer, llm }) => {
    const catalog = [
      { integration: "source_control", name: "GitHub" },
      { integration: "vercel", name: "Deployment platform" },
      { integration: "google_gmail", name: "Gmail" },
    ];
    const availability = { offline: false };
    const server = createServer({
      remoteConnections: {
        catalog: async () =>
          availability.offline ? new Error("Catalog unavailable") : catalog,
        startSetup: async () => new Error("unused"),
        setup: async () => new Error("unused"),
        cancelSetup: async () => undefined,
        connections: async () => [],
        removeConnection: async () => ({
          revocation: "not_supported" as const,
        }),
      },
    });
    await server.start();
    const thread = await server.rpc.thread.new();
    const prompting = server.promptAndWait({
      ...thread,
      text: "Check which integrations are supported",
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "catalog",
        arguments: {
          js: `await Promise.all([
            tools.executor.integrations.list({}),
            tools.executor.integrations.list({ query: "  gItHuB  " }),
            tools.executor.integrations.list({ query: "VERC" }),
            tools.executor.integrations.list({ query: "missing" }),
            tools.executor.integrations.list({ query: "   " }),
            tools.executor.integrations.list({ query: 42 })
          ]);`,
        },
      }),
    );
    await llm.respond(() => {
      availability.offline = true;
      return m.tool.start("exec", {
        id: "offline-catalog",
        arguments: {
          js: 'await tools.executor.integrations.list({ query: "github" });',
        },
      });
    });
    await llm.respond(m.assistant("Discovery is currently unavailable."));
    await prompting;
    const [listed, offline] = threadToolExecutions(
      await server.rpc.thread.snapshot(thread),
    );
    assert(listed?.type === "exec" && offline?.type === "exec");
    expect(listed.result?.details).toMatchObject({
      status: "completed",
      result: [
        { ok: true, data: catalog },
        { ok: true, data: [catalog[0]] },
        { ok: true, data: [catalog[1]] },
        { ok: true, data: [] },
        { ok: true, data: catalog },
        { ok: false, error: { code: "invalid_tool_arguments" } },
      ],
    });
    expect(offline.result?.details).toMatchObject({
      status: "completed",
      result: { ok: false, error: { code: "discovery_failed" } },
    });
  },
);

serverTest(
  "shows remote setup cards only for integrations in the live catalog",
  async ({ createServer, llm }) => {
    const setup = { cancelled: false };
    const catalog: { integration: string; name: string }[] = [];
    const availability = { offline: true };
    const server = createServer({
      remoteConnections: {
        catalog: async () =>
          availability.offline
            ? new Error("Control plane temporarily offline")
            : catalog,
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
    const thread = await server.rpc.thread.new();
    const prompting = server.promptAndWait({
      ...thread,
      text: "Connect the new MCP server",
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "offline-card",
        arguments: {
          js: 'await tools.halo.showConnectionCard({ integration: "new_mcp" });',
        },
      }),
    );
    await llm.respond(() => {
      availability.offline = false;
      return m.tool.start("exec", {
        id: "unsupported-card",
        arguments: {
          js: 'await tools.halo.showConnectionCard({ integration: "github" });',
        },
      });
    });
    await llm.respond(() => {
      catalog.push({ integration: "new_mcp", name: "New MCP" });
      return m.tool.start("exec", {
        id: "remote-connection",
        arguments: {
          js: `await Promise.allSettled([
            tools.halo.showConnectionCard({ integration: "new_mcp" }),
            tools.executor.coreTools.oauth.start({ client: "google", clientOwner: "org", owner: "user", name: "personal", integration: "google_gmail", template: "googleOAuth2" })
          ]);`,
        },
      });
    });
    await llm.respond(m.assistant("Use the connection card to connect."));
    await prompting;
    const executions = threadToolExecutions(
      await server.rpc.thread.snapshot(thread),
    );
    expect(executions).toHaveLength(3);
    for (const [index, code] of [
      "discovery_failed",
      "integration_unavailable",
    ].entries()) {
      const rejected = executions[index]!;
      assert(rejected.type === "exec");
      expect(rejected.result?.details).toMatchObject({
        status: "completed",
        result: { ok: false, error: { code } },
      });
      expect(rejected.result?.details).not.toHaveProperty("connectionRequests");
    }
    const execution = executions[2]!;
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
      ...thread,
      request,
    });
    expect(started).toMatchObject({
      status: "authorization-required",
      authorizationUrl: "https://halo.example/integrations/setup/setup",
    });
    if (started.status !== "authorization-required")
      throw new Error("Missing setup");
    await server.rpc.thread.cancelConnection({
      ...thread,
      connectionId: started.connectionId,
    });
    expect(
      (await server.rpc.thread.snapshot(thread)).connections,
    ).toMatchObject([{ request, status: "cancelled" }]);
  },
);

serverTest(
  "discovers local tools by canonical path, name and description",
  async ({ createServer, llm }) => {
    const headless = createServer();
    await headless.start();
    expect(
      await headless.rpc.testApi.invokeTool({
        path: "search",
        input: { query: "computer", source: "workspace" },
      }),
    ).toEqual({ tools: [], truncated: false, unavailableSources: [] });
    await headless.stop();

    const server = createServer({ desktopOrigin: "http://127.0.0.1:6080" });
    await server.start();
    const search = async (query: string, limit?: number) =>
      await server.rpc.testApi.invokeTool({
        path: "search",
        input: { query, limit, source: "workspace" },
      });
    const computerPaths = [
      "computer.back",
      "computer.click",
      "computer.close",
      "computer.createTab",
      "computer.drag",
      "computer.forward",
      "computer.getApp",
      "computer.getTab",
      "computer.goto",
      "computer.listApps",
      "computer.listTabs",
      "computer.observe",
      "computer.paste",
      "computer.pressKey",
      "computer.reload",
      "computer.scroll",
      "computer.setValue",
      "computer.typeText",
    ];
    for (const query of ["computer", "CoMpUtEr."]) {
      expect(await search(query)).toMatchObject({
        tools: computerPaths.map((toolPath) => ({
          path: toolPath,
          source: "workspace",
        })),
        truncated: false,
        unavailableSources: [],
      });
    }
    expect(await search("computer.OBSERVE")).toMatchObject({
      tools: [{ path: "computer.observe", name: "observe" }],
    });
    expect(await search("getApp")).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ path: "computer.getApp" }),
      ]),
    });
    expect(await search("UTF-8 file")).toMatchObject({
      tools: [{ path: "files.read" }, { path: "files.write" }],
    });
    expect(await search("computer", 2)).toMatchObject({
      tools: [{ path: "computer.back" }, { path: "computer.click" }],
      truncated: true,
    });
    expect(await search("")).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ path: "computer.observe" }),
        expect.objectContaining({ path: "files.read" }),
      ]),
      truncated: false,
    });
    expect(await search("nonexistent-tool-namespace")).toEqual({
      tools: [],
      truncated: false,
      unavailableSources: [],
    });

    const thread = await server.rpc.thread.new();
    const prompting = server.promptAndWait({
      ...thread,
      text: "Find the computer tools",
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "discover-computer",
        arguments: {
          js: 'await tools.search({ query: "computer", source: "workspace" })',
        },
      }),
    );
    await llm.respond(({ messages }) => {
      expect(messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "discover-computer",
          content: expect.stringContaining("computer.observe"),
        }),
      );
      return m.assistant("Found the observation tool");
    });
    await prompting;
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
        registerMcp: async () => undefined,
        registerApi: async () => undefined,
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
    const thread = await server.rpc.thread.new();
    const prompting = server.promptAndWait({
      ...thread,
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
    ({ search, description, result, local });
  `,
        },
      }),
    );
    await llm.respond(m.assistant("Done"));
    await prompting;
    const executions = threadToolExecutions(
      await server.rpc.thread.snapshot(thread),
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
      threadToolExecutions(await server.rpc.thread.snapshot(thread)),
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
      ...thread,
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
    const latest = threadToolExecutions(
      await server.rpc.thread.snapshot(thread),
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
      const thread = await server.rpc.thread.new();
      const prompting = server.promptAndWait({
        ...thread,
        text: `${decision} the policy`,
      });
      const js = `await tools.executor.coreTools.policies.create({ owner: "user", pattern: "approval-test-${decision}.*", action: "block" });`;
      await llm.respond(
        m.tool.start("exec", {
          id: `approval-request-${decision}`,
          arguments: { js },
        }),
      );
      await llm.respond(m.assistant(`Waiting for ${decision}`));
      await prompting;
      const pending = await server.rpc.thread.snapshot(thread);
      expect(pending.activeRun).toBeUndefined();
      const approval = threadToolExecutions(pending).flatMap((execution) =>
        execution.type === "exec" ? execution.approvals : [],
      )[0]!;
      expect(approval.status).toBe("pending");

      await server.rpc.thread.respondToToolApproval({
        ...thread,
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
          const snapshot = await server.rpc.thread.snapshot(thread);
          return {
            activeRun: snapshot.activeRun,
            executions: threadToolExecutions(snapshot),
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
      const completed = await server.rpc.thread.snapshot(thread);
      const executions = threadToolExecutions(completed);
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
      await server.rpc.thread.close(thread);
      const restored = await server.rpc.thread.snapshot(thread);
      expect(threadToolExecutions(restored)).toEqual(executions);
      await expect(
        server.rpc.thread.respondToToolApproval({
          ...thread,
          approvalId: approval.id,
          decision,
        }),
      ).rejects.toThrow("no longer pending");
    }
  },
);

serverTest(
  "enforces saved block and approval policies before workspace tool effects",
  async ({ server, llm }) => {
    await server.rpc.workspace.writeFile({
      path: "policy.txt",
      content: "original",
    });
    for (const [pattern, action] of [
      ["files.write", "block"],
      ["files.edit", "require_approval"],
    ]) {
      await server.rpc.testApi.invokeTool({
        path: "executor.coreTools.policies.create",
        input: { owner: "user", pattern, action },
      });
    }
    const thread = await server.rpc.thread.new();
    const blocked = server.promptAndWait({
      ...thread,
      text: "Attempt a blocked write",
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "blocked-write",
        arguments: {
          js: 'await tools.files.write({ path: "policy.txt", content: "blocked" })',
        },
      }),
    );
    await llm.respond(({ messages }) => {
      const output = messageText(
        messages.find(
          (message) =>
            message.role === "tool" && message.tool_call_id === "blocked-write",
        )!,
      );
      expect(JSON.parse(output)).toMatchObject({
        ok: false,
        error: { code: "tool_blocked" },
      });
      return m.assistant("Blocked.");
    });
    await blocked;
    await expect(
      server.rpc.testApi.invokeTool({
        path: "files.write",
        input: { path: "policy.txt", content: "also blocked" },
      }),
    ).rejects.toThrow("blocked");
    expect(await server.rpc.workspace.readFile({ path: "policy.txt" })).toBe(
      "original",
    );

    const js =
      'await tools.files.edit({ path: "policy.txt", oldText: "original", newText: "approved" })';
    const editing = server.promptAndWait({
      ...thread,
      text: "Request an edit",
    });
    await llm.respond(
      m.tool.start("exec", { id: "edit-request", arguments: { js } }),
    );
    await llm.respond(m.assistant("Waiting for approval."));
    await editing;
    const approval = threadToolExecutions(
      await server.rpc.thread.snapshot(thread),
    ).flatMap((execution) =>
      execution.type === "exec" ? execution.approvals : [],
    )[0]!;
    expect(approval).toMatchObject({
      toolPath: "files.edit",
      status: "pending",
    });
    expect(await server.rpc.workspace.readFile({ path: "policy.txt" })).toBe(
      "original",
    );

    await server.rpc.thread.respondToToolApproval({
      ...thread,
      approvalId: approval.id,
      decision: "allow",
    });
    await llm.respond(
      m.tool.start("exec", { id: "edit-retry", arguments: { js } }),
    );
    await llm.respond(m.assistant("Edited."));
    await expect
      .poll(
        async () => await server.rpc.workspace.readFile({ path: "policy.txt" }),
      )
      .toBe("approved");
    await expect
      .poll(async () => (await server.rpc.thread.snapshot(thread)).activeRun)
      .toBeUndefined();
  },
);

serverTest(
  "requires another approval when retry arguments change",
  async ({ server, llm }) => {
    const thread = await server.rpc.thread.new();
    const originalJs =
      'await tools.executor.coreTools.policies.create({ owner: "user", pattern: "approval-original.*", action: "block" });';
    const prompting = server.promptAndWait({
      ...thread,
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
    const pending = await server.rpc.thread.snapshot(thread);
    const originalApproval = threadToolExecutions(pending).flatMap(
      (execution) => (execution.type === "exec" ? execution.approvals : []),
    )[0]!;

    await server.rpc.thread.respondToToolApproval({
      ...thread,
      approvalId: originalApproval.id,
      decision: "allow",
    });
    const changedJs =
      'await tools.executor.coreTools.policies.create({ owner: "user", pattern: "approval-changed.*", action: "block" });';
    await llm.respond(
      m.tool.start("exec", {
        id: "approval-changed",
        arguments: { js: changedJs },
      }),
    );
    await llm.respond(m.assistant("The changed request needs approval"));

    await expect
      .poll(async () => {
        const snapshot = await server.rpc.thread.snapshot(thread);
        return {
          activeRun: snapshot.activeRun,
          approvals: threadToolExecutions(snapshot).flatMap((execution) =>
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
    const completed = await server.rpc.thread.snapshot(thread);
    const approvals = threadToolExecutions(completed).flatMap((execution) =>
      execution.type === "exec" ? execution.approvals : [],
    );
    expect(approvals).toMatchObject([
      { id: originalApproval.id, status: "allowed" },
      { status: "pending", arguments: { pattern: "approval-changed.*" } },
    ]);
  },
);

serverTest(
  "pushes thread summaries and catches up after reconnect and restart",
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
    const thread = await server.rpc.thread.new();
    expect((await updates.next()).value).toMatchObject({
      type: "updated",
      session: {
        ...thread,
        isRunning: false,
        markedDone: false,
      },
    });

    const prompting = server.promptAndWait({
      ...thread,
      text: "Work without an open conversation",
    });
    const running = await nextSummary(
      updates,
      (summary) => summary.isRunning && summary.title !== undefined,
    );
    expect(running).toMatchObject({
      ...thread,
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
      ...thread,
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
          ...thread,
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
      ...thread,
      text: "Stop this run",
    });
    await nextSummary(resumed, (summary) => summary.isRunning);
    await llm.waitForRequest();
    await server.rpc.thread.abort(thread);
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
          ...thread,
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
  "persists thread status commands and streams their summaries",
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

    // A thread without any transcript or product-state row can be marked done.
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
      throw new Error("Expected restored thread summary snapshot");
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
  updates: AsyncIterable<ThreadSummariesUpdate>,
  matches: (summary: ThreadSummary) => boolean,
) {
  // Consume without returning the iterator so the same connection remains usable.
  const iterator = updates[Symbol.asyncIterator]();
  while (true) {
    const next = await iterator.next();
    if (next.done)
      throw new Error("Thread summary stream ended before the expected update");
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
    const thread = await server.rpc.thread.new();
    const prompt = server.promptAndWait({
      ...thread,
      text: "Make Cmd+Shift+K open a new chat tab",
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "save-hotkey",
        arguments: {
          js: 'await tools.hotkeys.save({ label: "Quick chat", accelerator: "Cmd+Shift+K", action: { type: "newTab" } });',
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
    const updates = await server.rendererRpc.server.watch(
      { includeLegacyState: false },
      { signal: controller.signal },
    );
    const initial = new Set<string>();
    while (initial.size < 2) {
      const next = await updates.next();
      assert(!next.done, "Workspace stream ended before initial snapshots");
      initial.add(next.value.type);
    }
    expect(initial).toEqual(new Set(["extensions", "sessions"]));
    const thread = await server.rpc.thread.new();
    for await (const item of updates) {
      if (item.type !== "sessions") continue;
      expect(item.update).toMatchObject({
        type: "updated",
        session: { sessionId: thread.sessionId },
      });
      break;
    }
    const reconnected = await server.rendererRpc.server.watch(
      { includeLegacyState: false },
      { signal: controller.signal },
    );
    for await (const item of reconnected) {
      if (item.type !== "sessions") continue;
      expect(item.update).toMatchObject({
        type: "snapshot",
        sessions: [expect.objectContaining({ sessionId: thread.sessionId })],
      });
      break;
    }
    // Leaving a for-await loop must cancel every source, including idle ones.
    await server.stop();
  },
);

serverTest(
  "rejects unsupported protocol versions and writes",
  async ({ server }) => {
    const connected = await connectHaloClient({ transport: server.transport });
    assert(!(connected instanceof Error));
    expect(connected.serverInfo).toEqual({
      protocolVersion: haloProtocolVersion,
      supportedProtocols: haloSupportedProtocols,
    });
    for (const version of [18, 19, 21, 22, 23, 24]) {
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
    const thread = await legacy.thread.new();
    const prompting = server.promptAndWait({
      ...thread,
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
    const execution = threadToolExecutions(
      await legacy.thread.snapshot(thread),
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
      ...thread,
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
      .poll(async () => (await legacy.thread.snapshot(thread)).connections)
      .toMatchObject([{ request, status: "connected" }]);
    // Old desktop's unused callback timeout cannot cancel a completed setup.
    assert(started.status === "authorization-required");
    await legacy.thread.cancelConnection({
      ...thread,
      connectionId: started.connectionId,
    });
    expect((await legacy.thread.snapshot(thread)).connections).toMatchObject([
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
      ...thread,
      request: savedRequest,
      completion,
    });
    assert(failed.status === "authorization-required");
    await expect
      .poll(
        async () =>
          (await legacy.thread.snapshot(thread)).connections.find(
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

serverTest(
  "reserves idle maintenance before accepting new work and rejects untrusted maintenance callers",
  async ({ server }) => {
    const directory = path.join(
      server.workspaceRoot,
      ".halo/extensions/maintenance-check",
    );
    await fs.mkdir(path.join(directory, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "maintenance-check" }),
    );
    await fs.writeFile(
      path.join(directory, "dist/start.mjs"),
      `
      import http from "node:http";
      const server = http.createServer(async (_request, response) => {
        const result = await fetch(process.env.HALO_EXTENSION_TOOLS_ORIGIN + "/extension-tools/invoke", {
          method: "POST", headers: {authorization: "Bearer " + process.env.HALO_EXTENSION_TOOLS_TOKEN}, body: "{}"
        });
        response.writeHead(result.status).end();
      });
      server.listen(0, "127.0.0.1", () => process.send("http://127.0.0.1:" + server.address().port + "/view/"));
      process.on("message", message => { if(message === "shutdown") server.close(() => process.exit(0)); });
    `,
    );
    await server.rpc.extensions.reload();
    const url = `${server.transport.origin}/maintenance`;
    const headers = server.transport.headers;
    expect((await fetch(url)).status).toBe(401);
    expect(
      (await fetch(url, { headers: server.rendererTransport.headers })).status,
    ).toBe(403);
    await expect
      .poll(async () => (await (await fetch(url, { headers })).json()).busy)
      .toBe(false);
    expect((await fetch(url, { method: "PUT", headers })).status).toBe(405);
    expect((await fetch(url, { method: "POST", headers })).status).toBe(200);
    await expect(server.rpc.thread.new()).rejects.toThrow("503");
    expect(
      (
        await fetch(
          `${server.transport.origin}/extensions/maintenance-check/view/`,
          { headers },
        )
      ).status,
    ).toBe(503);
    expect((await fetch(url, { method: "DELETE", headers })).status).toBe(200);
    expect(await server.rpc.thread.new()).toHaveProperty("sessionId");
  },
);

serverTest(
  "refuses to reserve maintenance while an agent is running unless interruption is explicitly requested",
  async ({ server, llm }) => {
    const thread = await server.rpc.thread.new();
    const accepted = await server.rpc.thread.prompt({
      ...thread,
      text: "Keep working",
    });
    await llm.waitForRequest();
    const url = `${server.transport.origin}/maintenance`;
    expect(
      (await fetch(url, { method: "POST", headers: server.transport.headers }))
        .status,
    ).toBe(409);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: {
            ...server.transport.headers,
            "x-halo-force-update": "true",
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (await (await fetch(url, { headers: server.transport.headers })).json())
        .upgrading,
    ).toBe(true);
    await fetch(url, { method: "DELETE", headers: server.transport.headers });
    await llm.respond(m.assistant("Finished without interruption."));
    await server.rpc.thread.wait({ ...thread, ...accepted });
    expect(
      assistantReplies(await server.rpc.thread.snapshot(thread)),
    ).toContain("Finished without interruption.");
  },
);
