import fs from "node:fs/promises";
import path from "node:path";
import { Logger } from "@get-halo/logger";
import { JsonlLoggerSink } from "@get-halo/logger/JsonlLoggerSink";

type TestFiles = {
  write(input: { path: string; content: string | Uint8Array }): Promise<void>;
  read(path: string): Promise<Buffer>;
};

type TestPaths = {
  root: string;
  workspace: string;
  userData: string;
  logs: string;
};

type TestOutcome = {
  passed: boolean;
};

export async function createTestArtifacts(taskId: string) {
  const parent = path.resolve(import.meta.dirname, "../../../tmp/server");
  await fs.mkdir(parent, { recursive: true });
  const taskName = taskId.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
  const root = await fs.mkdtemp(path.join(parent, `${taskName}-`));
  const paths: TestPaths = {
    root,
    workspace: path.join(root, "workspace"),
    userData: path.join(root, "user-data"),
    logs: path.join(root, "logs"),
  };
  await Promise.all([
    fs.mkdir(paths.workspace, { recursive: true }),
    fs.mkdir(paths.userData, { recursive: true }),
    fs.mkdir(paths.logs, { recursive: true }),
  ]);

  const logger = new Logger({
    sinks: [
      new JsonlLoggerSink({
        filePath: path.join(paths.logs, "server.jsonl"),
      }),
    ],
  });
  const resolveFilePath = (filePath: string) => {
    const resolved = path.resolve(root, filePath);
    const relative = path.relative(root, resolved);
    if (relative === "..") throw new Error("Test file path escapes its root.");
    if (relative.startsWith(`..${path.sep}`)) {
      throw new Error("Test file path escapes its root.");
    }
    if (path.isAbsolute(relative)) {
      throw new Error("Test file path escapes its root.");
    }
    return resolved;
  };
  const files: TestFiles = {
    async write(input) {
      const filePath = resolveFilePath(input.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, input.content);
    },
    async read(filePath) {
      return await fs.readFile(resolveFilePath(filePath));
    },
  };
  const harness = {
    files,
    paths,
  };
  return {
    harness,
    logger,
    paths,
    async finish(outcome: TestOutcome) {
      logger.destroy();
      if (!outcome.passed) {
        console.error(`[serverTest] Artifacts retained: ${paths.root}`);
        return;
      }
      await fs.rm(paths.root, { recursive: true, force: true });
    },
  };
}

export type TestArtifacts = Awaited<ReturnType<typeof createTestArtifacts>>;
