import { execa } from "execa";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import nodePath, { join, resolve } from "node:path";
import { Logger } from "@get-halo/logger";
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
  loadExtension(sourceDirectory: string): Promise<{
    id: string;
    directory: string;
  }>;
};

type E2EFixtures = {
  llm: LLMDriver;
  http: HttpService;
  server: Exclude<
    Awaited<ReturnType<typeof startWorkspaceServerProcess>>,
    Error
  >;
  app: ElectronTestApp;
  testArtifacts: TestArtifacts;
  harness: E2ETestHarness;
};

type ExtensionPackages = {
  sdk: string;
  tools: string;
};

type E2EWorkerFixtures = {
  getExtensionPackages(): Promise<ExtensionPackages>;
};

const repository = nodePath.resolve(import.meta.dirname, "../../..");

class ExtensionSetupError extends errore.createTaggedError({
  name: "ExtensionSetupError",
  message: "Could not prepare workspace extension: $command",
}) {}

export const e2eTest = baseTest.extend<E2EFixtures, E2EWorkerFixtures>({
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
  server: [
    async ({ testArtifacts, llm, http }, use) => {
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
          environment: "local",
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
          extensionRuntime: {
            executable: process.execPath,
            electronRunAsNode: false,
          },
          oauthTest: {
            googleWebClient: {
              clientId: "e2e-google-web-client",
              clientSecret: "e2e-google-web-secret",
            },
            tokenOrigin: http.url(""),
          },
        },
      });
      if (server instanceof Error) throw server;
      cleanup.defer(async () => {
        const closed = await server.close();
        if (closed instanceof Error) throw closed;
      });
      await use(server);
    },
    { timeout: 60_000 },
  ],
  app: [
    // The server fixture publishes discovery files before Electron opens.
    async ({ testArtifacts, server: _server }, use) => {
      await using cleanup = new errore.AsyncDisposableStack();
      const app = new ElectronTestApp(testArtifacts);
      cleanup.defer(async () => await app.quit());
      await app.open();
      await use(app);
    },
    // Concurrent process startup has its own budget, separate from test actions.
    { auto: true, timeout: 60_000 },
  ],
  harness: async (
    { app, server, testArtifacts, getExtensionPackages },
    use,
    testInfo,
  ) => {
    await use({
      ...testArtifacts.harness,
      tools: createHarnessTools(server.rpc.testApi),
      async loadSession(description) {
        await app.page.getByRole("main").waitFor();
        const loaded = await loadSessionDescription({
          description,
          load: async (input) => await server.rpc.testApi.seedSession(input),
          getToolIdentity: async (path) =>
            await server.rpc.testApi.getToolIdentity({ path }),
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
      async loadExtension(sourceDirectory) {
        const { scaffoldExtension } =
          await import("@get-halo/extension-tools/scaffold");
        const source = nodePath.resolve(
          nodePath.dirname(testInfo.file),
          sourceDirectory,
        );
        const id = nodePath.basename(source);
        const parent = nodePath.join(
          testArtifacts.paths.workspace,
          ".halo",
          "extensions",
        );
        await mkdir(parent, { recursive: true });
        const directory = nodePath.join(parent, id);
        const scaffolded = await scaffoldExtension({
          directory,
          name: id,
          packages: await getExtensionPackages(),
        });
        if (scaffolded instanceof Error) throw scaffolded;
        await cp(source, directory, { recursive: true });
        await extensionCommand(
          "pnpm",
          [
            "install",
            "--dir",
            directory,
            "--lockfile-dir",
            directory,
            "--ignore-workspace",
            "--ignore-scripts",
            "--config.manage-package-manager-versions=false",
          ],
          directory,
        );
        await extensionCommand("npm", ["run", "typecheck"], directory);
        await extensionCommand("npm", ["run", "build"], directory);
        await app.server.rpc.extensions.reload();
        await app.page.reload();
        return { id, directory };
      },
    });
  },
  getExtensionPackages: [
    // oxlint-disable-next-line eslint/no-empty-pattern -- Playwright fixture callbacks require destructured parameters.
    async ({}, use) => {
      await using cleanup = new errore.AsyncDisposableStack();
      let extensionPackages: ExtensionPackages | undefined;
      await use(async () => {
        if (extensionPackages !== undefined) return extensionPackages;
        const parent = nodePath.join(repository, "tmp", "extension-host");
        await mkdir(parent, { recursive: true });
        const directory = await mkdtemp(nodePath.join(parent, "packages-"));
        cleanup.defer(
          async () => await rm(directory, { recursive: true, force: true }),
        );
        const packed: string[] = [];
        for (const name of ["extension-sdk", "extension-tools"]) {
          const cwd = nodePath.join(repository, "packages", name);
          await extensionCommand("npm", ["run", "build"], cwd);
          const result = await extensionCommand(
            "npm",
            ["pack", "--ignore-scripts", "--pack-destination", directory],
            cwd,
          );
          packed.push(`file:${nodePath.join(directory, result.stdout.trim())}`);
        }
        extensionPackages = {
          sdk: packed[0]!,
          tools: packed[1]!,
        };
        return extensionPackages;
      });
    },
    { scope: "worker", timeout: 180_000 },
  ],
});

async function extensionCommand(
  executable: string,
  args: string[],
  cwd: string,
) {
  const result = await execa(executable, args, {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
  }).catch(
    (cause) =>
      new ExtensionSetupError({
        command: `${executable} ${args.join(" ")}`,
        cause,
      }),
  );
  if (result instanceof Error) throw result;
  return result;
}
