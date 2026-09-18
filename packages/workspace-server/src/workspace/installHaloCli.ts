import * as errore from "errore";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FilesystemService } from "../filesystem/FilesystemService.js";

export class InstallHaloCliError extends errore.createTaggedError({
  name: "InstallHaloCliError",
  message: "Failed to install halo CLI: $detail",
}) {}

function haloCliBinDir(workspaceRoot: string) {
  return join(workspaceRoot, ".halo", "bin");
}

export function workspaceExecutablePath(
  workspaceRoot: string,
  path = process.env.PATH,
) {
  const binDirectories = [
    haloCliBinDir(workspaceRoot),
    join(workspaceRoot, ".local", "bin"),
  ];
  const workspacePath = binDirectories.join(delimiter);
  return path === undefined
    ? workspacePath
    : `${workspacePath}${delimiter}${path}`;
}

function haloCliBinPath(workspaceRoot: string) {
  return join(haloCliBinDir(workspaceRoot), "halo");
}

function wrapHaloCli(args: {
  appVersion: string;
  appDataDir: string;
  cliEntry: string;
  importHook?: string;
  nodeExecutable: string;
  electronRunAsNode: boolean;
}) {
  const nodeArgs =
    args.importHook === undefined
      ? [args.cliEntry]
      : ["--import", pathToFileURL(args.importHook).href, args.cliEntry];
  // Electron treats extra argv as app args unless this is set, and then runs
  // as Node using this same binary.
  const runAsNode = args.electronRunAsNode
    ? "export ELECTRON_RUN_AS_NODE=1\n"
    : "";
  const development =
    args.importHook === undefined
      ? ""
      : `export HALO_EXTENSION_SOURCE=${shQuote(join(dirname(args.cliEntry), "../.."))}\n`;
  return `#!/bin/sh
export HALO_VERSION=${shQuote(args.appVersion)}
export HALO_USER_DATA=${shQuote(args.appDataDir)}
${development}${runAsNode}exec ${shQuote(args.nodeExecutable)} ${nodeArgs.map(shQuote).join(" ")} "$@"
`;
}

function shQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function resolveHaloCliImportHook(cliEntry: string) {
  if (!cliEntry.endsWith(".ts")) return undefined;
  const require = createRequire(pathToFileURL(cliEntry).href);
  return errore.try({
    try: () => require.resolve("tsx"),
    catch: (e) =>
      new InstallHaloCliError({ detail: "could not resolve tsx", cause: e }),
  });
}

export async function installHaloCli(args: {
  filesystem: FilesystemService;
  workspaceRoot: string;
  appVersion: string;
  appDataDir: string;
  cliEntry: string;
  nodeExecutable?: string;
  electronRunAsNode?: boolean;
}) {
  const binPath = haloCliBinPath(args.workspaceRoot);
  const importHook = resolveHaloCliImportHook(args.cliEntry);
  if (importHook instanceof Error) return importHook;

  const created = await args.filesystem.makeDirectory(
    haloCliBinDir(args.workspaceRoot),
    {
      recursive: true,
    },
  );
  if (created instanceof Error) {
    return new InstallHaloCliError({ detail: "mkdir bin", cause: created });
  }

  const script = wrapHaloCli({
    appVersion: args.appVersion,
    appDataDir: args.appDataDir,
    cliEntry: args.cliEntry,
    importHook,
    nodeExecutable:
      args.nodeExecutable === undefined ? "node" : args.nodeExecutable,
    electronRunAsNode: args.electronRunAsNode === true,
  });
  if (args.filesystem.exists(binPath)) {
    const existing = await args.filesystem.readFile(binPath, "utf8");
    if (existing instanceof Error)
      return new InstallHaloCliError({ detail: "read halo", cause: existing });
    if (existing === script) return binPath;
  }
  const written = await args.filesystem.writeFile(binPath, script, {
    mode: 0o755,
  });
  if (written instanceof Error) {
    return new InstallHaloCliError({ detail: "write halo", cause: written });
  }
  const mode = await args.filesystem.chmod(binPath, 0o755);
  if (mode instanceof Error) {
    return new InstallHaloCliError({ detail: "chmod halo", cause: mode });
  }
  return binPath;
}
