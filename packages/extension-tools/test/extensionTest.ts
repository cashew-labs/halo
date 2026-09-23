import { test as base } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { scaffoldExtension } from "@get-halo/extension-tools/scaffold";
import * as errore from "errore";

const exec = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "../../..");
class ExtensionTestError extends errore.createTaggedError({
  name: "ExtensionTestError",
  message: "Extension test failed: $detail",
}) {}

type RunningExtension = Awaited<ReturnType<typeof start>>;

export const extensionTest = base.extend<
  {
    loadExtension(
      sourceDirectory?: string,
    ): Promise<{ url: string; restart(): Promise<void> }>;
  },
  { packages: { sdk: string; tools: string } }
>({
  packages: [
    // Playwright requires a destructured fixture argument even when no fixtures are used.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const parent = path.join(repository, "tmp", "extension-prototype");
      await mkdir(parent, { recursive: true });
      const root = await mkdtemp(path.join(parent, "packages-"));
      const sdk = await command(
        "npm",
        ["pack", "--ignore-scripts", "--pack-destination", root],
        path.join(repository, "packages", "extension-sdk"),
      );
      const tools = await command(
        "npm",
        ["pack", "--ignore-scripts", "--pack-destination", root],
        path.join(repository, "packages", "extension-tools"),
      );
      await use({
        sdk: `file:${path.join(root, sdk.stdout.trim())}`,
        tools: `file:${path.join(root, tools.stdout.trim())}`,
      });
    },
    { scope: "worker", timeout: 180_000 },
  ],
  loadExtension: async ({ packages }, use, info) => {
    await using cleanup = new errore.AsyncDisposableStack();
    await use(async (sourceDirectory) => {
      const root = await mkdtemp(
        path.join(repository, "tmp", "extension-prototype", "loaded-"),
      );
      const directory = path.join(root, "app");
      cleanup.defer(async () => {
        await rm(path.join(directory, "node_modules"), {
          recursive: true,
          force: true,
        });
        if (info.status !== info.expectedStatus) {
          console.warn(`Extension artifacts retained: ${root}`);
          return;
        }
        await rm(root, { recursive: true, force: true });
      });
      const scaffolded = await scaffoldExtension({
        directory,
        name: "test-extension",
        packages,
      });
      if (scaffolded instanceof Error) throw scaffolded;
      if (sourceDirectory !== undefined) {
        for (const file of await readdir(sourceDirectory)) {
          await cp(
            path.join(sourceDirectory, file),
            path.join(directory, file),
          );
        }
      }
      await command(
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
      await command("npm", ["run", "check"], directory);
      await command("npm", ["run", "build"], directory);
      const dataDirectory = path.join(root, "data");
      let running: RunningExtension = await start(directory, dataDirectory);
      cleanup.defer(async () => await running.stop());
      return {
        get url() {
          return running.url;
        },
        async restart() {
          await running.stop();
          running = await start(directory, dataDirectory);
        },
      };
    });
  },
});

async function command(executable: string, args: string[], cwd: string) {
  const result = await exec(executable, args, {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
  }).catch(
    (cause) =>
      new ExtensionTestError({
        detail: [`${executable} ${args.join(" ")}`, cause.stdout, cause.stderr]
          .filter((value): value is string => typeof value === "string")
          .join("\n"),
        cause,
      }),
  );
  if (result instanceof Error) throw result;
  return result;
}

async function start(directory: string, dataDirectory: string) {
  const child = spawn(
    process.execPath,
    [
      "dist/start.mjs",
      "--port",
      "0",
      "--data-dir",
      dataDirectory,
      "--workspace-root",
      directory,
    ],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  const url = await new Promise<string>((resolve, reject) => {
    child.once("error", (cause) =>
      reject(new ExtensionTestError({ detail: "start process", cause })),
    );
    child.once("exit", () =>
      reject(new ExtensionTestError({ detail: output })),
    );
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(
        /Listening on (http:\/\/127\.0\.0\.1:\d+\/view\/)/,
      );
      if (match !== null) resolve(match[1]!);
    });
  });
  return {
    url,
    async stop() {
      child.kill("SIGTERM");
      const code = await exited;
      if (code !== 0) throw new ExtensionTestError({ detail: output });
    },
  };
}
