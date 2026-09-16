import fs from "node:fs/promises";
import path from "node:path";
import * as errore from "errore";
import { formatExecuteResult } from "@executor-js/execution/core";
import type { ExecuteResult } from "@executor-js/codemode-core";
import { expect, test as baseTest, vi } from "vitest";
import { FileCredentialVault } from "../src/agent/runtime/FileCredentialVault.js";
import { StaticAgentAuthority } from "../src/agent/runtime/AgentAuthority.js";
import { ToolRuntime } from "../src/agent/runtime/ToolRuntime.js";
import { workspaceBashPlugin } from "../src/agent/tools/bash/workspaceBashPlugin.js";
import { createWorkspaceFilesPlugin } from "../src/agent/tools/files/createWorkspaceFilesPlugin.js";
import { parallelSearchPlugin } from "../src/agent/tools/web/parallelSearchPlugin.js";
import { FilesystemService } from "../src/filesystem/FilesystemService.js";
import { DatabaseClient } from "../src/storage/DatabaseClient.js";

vi.setConfig({ testTimeout: 60_000 });

const toolRuntimeTest = baseTest.extend<{ runtime: ToolRuntime }>({
  runtime: [
    // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest fixture callbacks require destructured parameters.
    async ({}, use) => {
      const parent = path.resolve(
        import.meta.dirname,
        "../../../tmp/web-fetch-harness",
      );
      await fs.mkdir(parent, { recursive: true });
      const root = await fs.mkdtemp(path.join(parent, "ws-"));
      await using cleanup = new errore.AsyncDisposableStack();
      const filesystem = new FilesystemService();
      cleanup.defer(async () => {
        const closed = await filesystem.close();
        if (closed instanceof Error)
          console.warn(
            "Failed to close filesystem after web fetch harness:",
            closed,
          );
      });
      const database = await DatabaseClient.open({
        directory: path.join(root, ".halo"),
        filesystem,
      });
      if (database instanceof Error) throw database;
      cleanup.defer(async () => {
        const closed = await database.close();
        if (closed instanceof Error)
          console.warn(
            "Failed to close database after web fetch harness:",
            closed,
          );
      });
      const runtime = await ToolRuntime.create({
        database,
        workspaceRoot: root,
        userId: "web-fetch-harness",
        credentialVault: new FileCredentialVault({
          filesystem,
          directory: path.join(root, ".halo", "executor", "credentials"),
        }),
        toolPlugins: [
          createWorkspaceFilesPlugin(filesystem),
          workspaceBashPlugin,
          parallelSearchPlugin,
        ],
        authority: new StaticAgentAuthority([
          "workspace.files.read",
          "workspace.files.write",
          "workspace.shell.execute",
          "network.web.search",
        ]),
        oauthRedirectUri: "http://127.0.0.1/oauth/callback",
      });
      if (runtime instanceof Error) throw runtime;
      cleanup.defer(async () => {
        const closed = await runtime.close();
        if (closed instanceof Error)
          console.warn(
            "Failed to close tool runtime after web fetch harness:",
            closed,
          );
      });
      await use(runtime);
    },
    { scope: "file" },
  ],
});

toolRuntimeTest(
  "describe.tool returns the web.fetch schema with urls",
  async ({ runtime }) => {
    const execution = await execute(
      runtime,
      `return await tools.describe.tool({ path: "web.fetch" })`,
    );
    expectDescribedWebFetch(execution);
  },
);

toolRuntimeTest(
  "describe.tool accepts a tools. prefix for web.fetch",
  async ({ runtime }) => {
    const execution = await execute(
      runtime,
      `return await tools.describe.tool({ path: "tools.web.fetch" })`,
    );
    expectDescribedWebFetch(execution);
  },
);

toolRuntimeTest(
  "nested tools.web.fetch accepts a single url alias",
  async ({ runtime }) => {
    const execution = await execute(
      runtime,
      `return await tools.web.fetch({ url: "https://example.com" })`,
    );
    expectNotInvalidToolArguments(execution);
  },
);

toolRuntimeTest(
  "bracket web.fetch accepts a single url alias",
  async ({ runtime }) => {
    const execution = await execute(
      runtime,
      `return await tools['web.fetch']({ url: "https://example.com" })`,
    );
    expectNotInvalidToolArguments(execution);
  },
);

toolRuntimeTest(
  "canonical tools['web.fetch']({ urls }) is not invalid_tool_arguments",
  async ({ runtime }) => {
    const execution = await execute(
      runtime,
      `return await tools['web.fetch']({ urls: ["https://example.com"] })`,
    );
    expectNotInvalidToolArguments(execution);
  },
);

toolRuntimeTest(
  "schema errors name urls when arguments are missing",
  async ({ runtime }) => {
    const execution = await execute(
      runtime,
      `return await tools['web.fetch']({})`,
    );
    const formatted = formatExecuteResult(execution);
    expect(formatted.isError).toBe(true);
    expect(formatted.text).toContain("urls");
    expect(formatted.text).not.toBe("Error: Expected required property");
  },
);

toolRuntimeTest(
  "invalid_tool_arguments rejects so a discarded await is not (no result)",
  async ({ runtime }) => {
    const execution = await execute(runtime, `await tools['web.fetch']({})`);
    const formatted = formatExecuteResult(execution);
    expect(formatted.isError).toBe(true);
    expect(formatted.text).toContain("urls");
    expect(formatted.text).not.toContain("(no result)");
  },
);

toolRuntimeTest(
  "describe.tool still returns a value when the path is missing",
  async ({ runtime }) => {
    const execution = await execute(
      runtime,
      `return await tools.describe.tool({ path: "no.such.tool" })`,
    );
    expect(execution.error).toBeUndefined();
    expect(formatExecuteResult(execution).text).toContain("tool_not_found");
  },
);

async function execute(runtime: ToolRuntime, code: string) {
  const execution = await runtime.executeCode({
    code,
    parentToolCallId: "web-fetch-harness",
  });
  if (execution instanceof Error) throw execution;
  return execution;
}

function expectDescribedWebFetch(execution: ExecuteResult) {
  const formatted = formatExecuteResult(execution);
  expect(formatted.isError).toBe(false);
  expect(formatted.text).toContain("urls");
  expect(formatted.text).not.toContain("tool_not_found");
}

function expectNotInvalidToolArguments(execution: ExecuteResult) {
  const errorText = execution.error === undefined ? "" : execution.error;
  const text = `${errorText} ${JSON.stringify(execution.result)}`;
  expect(text).not.toContain("invalid_tool_arguments");
  expect(text).not.toContain("did not match the input schema");
}
