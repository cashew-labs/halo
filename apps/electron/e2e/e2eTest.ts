import { join, resolve } from "node:path";
import { Logger } from "@repo/logger";
import { startWorkspaceServerProcess } from "./startWorkspaceServerProcess.js";
import type { SessionDescription } from "@get-halo/shared/testing";
import { test as baseTest } from "@playwright/test";
import * as errore from "errore";
import { createTestArtifacts, type TestArtifacts } from "./TestArtifacts.js";
import { ElectronTestApp } from "./ElectronTestApp.js";
import { LLMDriver, HttpService } from "@get-halo/workspace-server/testing";
import { createHarnessTools } from "./tools.js";
import { loadSessionDescription } from "./loadSessionDescription.js";

type E2ESession = {
  sessionId: string;
};

type E2ETestHarness = TestArtifacts["harness"] & {
  tools: ReturnType<typeof createHarnessTools>;
  loadSession(description: SessionDescription): Promise<E2ESession>;
};

type E2EFixtures = {
  llm: LLMDriver;
  http: HttpService;
  app: ElectronTestApp;
  testArtifacts: TestArtifacts;
  harness: E2ETestHarness;
};

export const e2eTest = baseTest.extend<E2EFixtures>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Fixture callbacks require destructured parameters.
  http: async ({}, use) => {
    const http = await HttpService.start();
    if (http instanceof Error) throw http;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => await http.close());
    await use(http);
  },
  // oxlint-disable-next-line eslint/no-empty-pattern -- Playwright fixture callbacks require an object-destructured first parameter.
  llm: async ({}, use) => {
    const llm = await LLMDriver.start();
    if (llm instanceof Error) throw llm;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => await llm.close());
    await use(llm);
  },
  // oxlint-disable-next-line eslint/no-empty-pattern -- Playwright fixture callbacks require an object-destructured first parameter.
  testArtifacts: async ({}, use, testInfo) => {
    const artifacts = await createTestArtifacts(testInfo);
    await use(artifacts);
    const finished = await artifacts.finish();
    if (finished instanceof Error) throw finished;
  },
  app: [
    async ({ testArtifacts, llm }, use) => {
      await using cleanup = new errore.AsyncDisposableStack();
      const server = await startWorkspaceServerProcess({
        entry: resolve(
          import.meta.dirname,
          "../../workspace-server/src/main.ts",
        ),
        configPath: join(testArtifacts.paths.root, "server.config.json"),
        logger: new Logger({
          sinks: [{ log: (entry) => console.log(entry.data) }],
        }),
        llmConfiguration: llm.configuration,
        config: {
          workspaceRoot: testArtifacts.paths.workspace,
          appDataDir: testArtifacts.paths.userData,
          appVersion: "0.0.0-test",
          ownerUserId: "e2e-user",
          logFilePath: testArtifacts.paths.haloLog,
          corsOrigins: ["null"],
          port: 0,
          cliEntry: resolve(
            import.meta.dirname,
            "../../../packages/halo-cli/src/cli.ts",
          ),
          cliNodeExecutable: process.execPath,
          testingApiEnabled: true,
        },
      });
      if (server instanceof Error) throw server;
      cleanup.defer(async () => {
        const closed = await server.close();
        if (closed instanceof Error) throw closed;
      });
      const app = new ElectronTestApp(testArtifacts);
      cleanup.defer(async () => await app.quit());
      await app.open();
      await use(app);
    },
    // Concurrent process startup has its own budget, separate from test actions.
    { auto: true, timeout: 60_000 },
  ],
  harness: async ({ app, testArtifacts }, use) => {
    await use({
      ...testArtifacts.harness,
      tools: createHarnessTools(() => app.server.rpc),
      async loadSession(description) {
        await app.page.getByRole("main").waitFor();
        const loaded = await loadSessionDescription({
          description,
          load: async (input) =>
            await app.server.rpc.testHarness.loadSession(input),
          getToolIdentity: async (path) =>
            await app.server.rpc.testHarness.getToolIdentity({ path }),
        });
        if (loaded instanceof Error) throw loaded;
        await app.page.reload();
        await app.page
          .getByRole("link", { name: description.title, exact: true })
          .click();
        await app.page
          .getByRole("main", { name: description.title, exact: true })
          .waitFor();
        return loaded;
      },
    });
  },
});
