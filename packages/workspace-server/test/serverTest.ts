import * as errore from "errore";
import { test as baseTest, vi } from "vitest";
import { createTestArtifacts } from "./TestArtifacts.js";
import { createOpenAILLMApi } from "@get-halo/workspace-server/llm";
import { HttpService, LLMDriver } from "@get-halo/workspace-server/testing";
import { TestServer } from "./TestServer.js";
import type { WorkspaceServerOptions } from "@get-halo/workspace-server";

// Server setup and teardown can exceed Vitest's five-second default in CI.
vi.setConfig({ testTimeout: 20_000 });

type ServerOptions = {
  workspaceRoot?: string;
  testApiEnabled?: boolean;
  traceUploader?: WorkspaceServerOptions["host"]["traceUploader"];
  traceWorkspaceId?: string;
};

export const serverTest = baseTest.extend<{
  llm: LLMDriver;
  http: HttpService;
  server: TestServer;
  createServer: (options?: ServerOptions) => TestServer;
}>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest fixture callbacks require destructured parameters.
  llm: async ({}, use) => {
    const llm = await LLMDriver.start();
    if (llm instanceof Error) throw llm;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => await llm.close());
    await use(llm);
  },
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest fixture callbacks require destructured parameters.
  http: async ({}, use) => {
    const http = await HttpService.start();
    if (http instanceof Error) throw http;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => await http.close());
    await use(http);
  },
  server: async ({ createServer }, use) => {
    const server = createServer();
    await server.start();
    await use(server);
  },
  createServer: async ({ task, llm }, use) => {
    await using artifactsCleanup = new errore.AsyncDisposableStack();
    const artifacts = await createTestArtifacts(task.id);
    const outcome = { passed: false };
    artifactsCleanup.defer(async () => await artifacts.finish(outcome));
    await using cleanup = new errore.AsyncDisposableStack();
    await use((options = {}) => {
      const server = new TestServer({
        artifacts,
        llmApi: createOpenAILLMApi(llm.configuration),
        traceUploader: options.traceUploader,
        traceWorkspaceId: options.traceWorkspaceId,
        workspaceRoot:
          options.workspaceRoot === undefined
            ? artifacts.paths.workspace
            : options.workspaceRoot,
        testApiEnabled: options.testApiEnabled,
      });
      cleanup.defer(async () => await server.stop());
      return server;
    });
    await cleanup.disposeAsync();
    outcome.passed = task.result?.state === "pass";
  },
});
