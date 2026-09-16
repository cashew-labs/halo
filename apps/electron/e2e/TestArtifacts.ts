import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { createHaloClient, type HaloClient } from "@get-halo/client";
import type { ConsoleMessage, Page, Request, TestInfo } from "@playwright/test";
import * as errore from "errore";

class TestArtifactError extends errore.createTaggedError({
  name: "TestArtifactError",
  message: "Could not $operation E2E test artifacts",
}) {}

type TestPaths = {
  root: string;
  workspace: string;
  userData: string;
  playwright: string;
  rendererLog: string;
  haloLog: string;
};

type LaunchArtifacts = {
  mainStdoutLog: string;
  mainStderrLog: string;
  screenshot: string;
  trace: string;
};

type E2ETestHarness = {
  createClient(serverHost: string, serverPort: number): HaloClient;
  paths: TestPaths;
};

export type TestArtifacts = {
  harness: E2ETestHarness;
  paths: TestPaths;
  createLaunch(): LaunchArtifacts;
  captureProcess(
    mainProcess: ChildProcess,
    launch: LaunchArtifacts,
  ): void | TestArtifactError;
  captureRenderer(page: Page): Promise<void | TestArtifactError>;
  captureScreenshot(
    page: Page,
    launch: LaunchArtifacts,
  ): Promise<void | TestArtifactError>;
  finish(): Promise<void | TestArtifactError>;
};

export async function createTestArtifacts(
  testInfo: TestInfo,
): Promise<TestArtifacts> {
  const parent = path.resolve(import.meta.dirname, "../../../tmp/e2e");
  await fsPromises.mkdir(parent, { recursive: true });
  // Keep nested executable paths below Windows process-spawning limits.
  const testName = testInfo.titlePath
    .join("-")
    .replaceAll(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 40);
  const root = await fsPromises.mkdtemp(path.join(parent, `${testName}-`));
  const paths = {
    root,
    workspace: path.join(root, "workspace"),
    userData: path.join(root, "user-data"),
    playwright: path.join(root, "playwright"),
    rendererLog: path.join(root, "renderer.console.log"),
    haloLog: path.join(root, "user-data", "logs", "halo.jsonl"),
  };
  await Promise.all([
    fsPromises.mkdir(paths.workspace, { recursive: true }),
    fsPromises.mkdir(paths.userData, { recursive: true }),
  ]);

  const outputPrefix = `[e2e:${testInfo.title}:main]`;
  const captureFinalizers: Array<() => Promise<void>> = [];
  const launches: LaunchArtifacts[] = [];

  const rendererLogInitialized = fsPromises
    .writeFile(paths.rendererLog, "")
    .catch(
      (cause) =>
        new TestArtifactError({ operation: "initialize renderer log", cause }),
    );
  const rendererLog = createRendererLog({
    path: paths.rendererLog,
    prefix: `[e2e:${testInfo.title}:renderer]`,
  });
  let rendererIndex = 0;

  const harness: E2ETestHarness = {
    createClient(serverHost, serverPort) {
      return createHaloClient({
        transport: {
          origin: `http://${serverHost}:${serverPort}`,
          path: "/rpc",
          headers: {},
        },
      });
    },
    paths,
  };
  return {
    harness,
    paths,
    createLaunch() {
      const prefix = path.join(root, `launch-${launches.length + 1}`);
      const launch = {
        mainStdoutLog: `${prefix}.main.stdout.log`,
        mainStderrLog: `${prefix}.main.stderr.log`,
        screenshot: `${prefix}.renderer.png`,
        trace: `${prefix}.trace.zip`,
      };
      launches.push(launch);
      return launch;
    },
    captureProcess(mainProcess: ChildProcess, launch: LaunchArtifacts) {
      if (mainProcess.stdout === null || mainProcess.stderr === null) {
        return new TestArtifactError({ operation: "capture main process" });
      }
      captureFinalizers.push(
        captureProcessOutput({
          input: mainProcess.stdout,
          logPath: launch.mainStdoutLog,
          prefix: outputPrefix,
          terminal: process.stdout,
        }),
        captureProcessOutput({
          input: mainProcess.stderr,
          logPath: launch.mainStderrLog,
          prefix: outputPrefix,
          terminal: process.stderr,
        }),
      );
    },
    async captureRenderer(page: Page) {
      const initialized = await rendererLogInitialized;
      if (initialized instanceof Error) return initialized;
      const windowLabel = `[window:${rendererIndex++}]`;
      const onConsole = (message: ConsoleMessage) => {
        rendererLog.write(
          `${windowLabel}[console:${message.type()}] ${message.text()}`,
        );
      };
      const onPageError = (error: Error) => {
        rendererLog.write(
          `${windowLabel}[pageerror] ${error.stack === undefined ? error.message : error.stack}`,
        );
      };
      const onRequestFailed = (request: Request) => {
        const failure = request.failure();
        const detail = failure === null ? "unknown failure" : failure.errorText;
        rendererLog.write(
          `${windowLabel}[requestfailed] ${request.method()} ${request.url()}: ${detail}`,
        );
      };
      page.on("console", onConsole);
      page.on("pageerror", onPageError);
      page.on("requestfailed", onRequestFailed);
      captureFinalizers.push(async () => {
        page.off("console", onConsole);
        page.off("pageerror", onPageError);
        page.off("requestfailed", onRequestFailed);
        await rendererLog.finish();
      });
    },
    async captureScreenshot(page: Page, launch: LaunchArtifacts) {
      return await page
        .screenshot({ path: launch.screenshot, fullPage: true })
        .then(() => undefined)
        .catch(
          (cause) =>
            new TestArtifactError({
              operation: "capture renderer screenshot",
              cause,
            }),
        );
    },
    async finish() {
      const finalized = await Promise.all(
        captureFinalizers.map(async (finalize) => await finalize()),
      ).catch(
        (cause) => new TestArtifactError({ operation: "finalize logs", cause }),
      );
      if (finalized instanceof Error) {
        retainArtifacts(paths.root);
        return finalized;
      }

      if (
        testInfo.status !== testInfo.expectedStatus ||
        testInfo.status === "failed"
      ) {
        const pruned = await removeDependencyDirectories(paths.root);
        if (pruned instanceof Error) {
          retainArtifacts(paths.root);
          return pruned;
        }
        const attached = await attachArtifacts({ testInfo, paths, launches });
        retainArtifacts(paths.root);
        return attached;
      }

      const removed = await fsPromises
        .rm(paths.root, { recursive: true, force: true })
        .catch(
          (cause) =>
            new TestArtifactError({ operation: "remove passing", cause }),
        );
      if (removed instanceof Error) retainArtifacts(paths.root);
      return removed;
    },
  };
}

async function removeDependencyDirectories(
  directory: string,
): Promise<void | TestArtifactError> {
  const entries = await fsPromises
    .readdir(directory, { withFileTypes: true })
    .catch(
      (cause) =>
        new TestArtifactError({
          operation: "list dependency directories",
          cause,
        }),
    );
  if (entries instanceof Error) return entries;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(directory, entry.name);
    const removed =
      entry.name === "node_modules"
        ? await fsPromises.rm(child, { recursive: true, force: true }).catch(
            (cause) =>
              new TestArtifactError({
                operation: "remove test dependencies",
                cause,
              }),
          )
        : await removeDependencyDirectories(child);
    if (removed instanceof Error) return removed;
  }
}

function captureProcessOutput(args: {
  input: NodeJS.ReadableStream;
  logPath: string;
  prefix: string;
  terminal: NodeJS.WritableStream;
}) {
  let pendingLine = "";
  let writes = fsPromises.writeFile(args.logPath, "");
  const onData = (chunk: Buffer | string) => {
    writes = writes.then(
      async () => await fsPromises.appendFile(args.logPath, chunk),
    );
    const text = pendingLine + chunk.toString();
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) {
      pendingLine = text;
      return;
    }
    pendingLine = text.slice(lastNewline + 1);
    for (const line of text.slice(0, lastNewline).split("\n")) {
      args.terminal.write(`${args.prefix} ${line}\n`);
    }
  };
  args.input.on("data", onData);
  return async () => {
    args.input.off("data", onData);
    if (pendingLine.length > 0) {
      args.terminal.write(`${args.prefix} ${pendingLine}\n`);
    }
    await writes;
  };
}

function createRendererLog(args: { path: string; prefix: string }) {
  let writes = Promise.resolve();
  return {
    write(line: string) {
      process.stdout.write(`${args.prefix} ${line}\n`);
      writes = writes.then(
        async () => await fsPromises.appendFile(args.path, `${line}\n`),
      );
    },
    async finish() {
      await writes;
    },
  };
}

async function attachArtifacts(args: {
  testInfo: TestInfo;
  paths: TestPaths;
  launches: LaunchArtifacts[];
}) {
  const attachments = [
    ...args.launches.flatMap(
      (launch, index) =>
        [
          [`launch ${index + 1} renderer screenshot`, launch.screenshot],
          [`launch ${index + 1} Playwright trace`, launch.trace],
          [`launch ${index + 1} main stdout`, launch.mainStdoutLog],
          [`launch ${index + 1} main stderr`, launch.mainStderrLog],
        ] as const,
    ),
    ["renderer console", args.paths.rendererLog],
    ["Halo JSONL log", args.paths.haloLog],
  ] as const;
  return await Promise.all(
    attachments
      .filter(([, filePath]) => fs.existsSync(filePath))
      .map(
        async ([name, filePath]) =>
          await args.testInfo.attach(name, { path: filePath }),
      ),
  )
    .then(() => undefined)
    .catch(
      (cause) => new TestArtifactError({ operation: "attach failure", cause }),
    );
}

function retainArtifacts(root: string): void {
  console.error(`[e2e] Artifacts retained: ${root}`);
}
