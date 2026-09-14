import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  HaloRpcFileError,
  readHaloRpcFile,
  rpcFilePath,
} from "./HaloRpcFile.js";

export type FindHaloRpcFileArgs = {
  rpcFile: string | undefined;
  userDataDir: string | undefined;
  cwd: string;
  homeDir: string;
  platform: NodeJS.Platform;
  appData: string | undefined;
};

export async function findHaloRpcFile(args: FindHaloRpcFileArgs) {
  if (args.rpcFile !== undefined && args.rpcFile.length > 0) {
    return await readHaloRpcFile(args.rpcFile);
  }

  if (args.userDataDir !== undefined && args.userDataDir.length > 0) {
    return await readHaloRpcFile(rpcFilePath(args.userDataDir));
  }

  const platformFile = platformRpcFile(args);
  if (platformFile !== undefined && existsSync(platformFile)) {
    return await readHaloRpcFile(platformFile);
  }

  const walked = walkUpRpcFile(args.cwd);
  if (walked !== undefined) return await readHaloRpcFile(walked);

  return new HaloRpcFileError({ detail: "Halo is not running" });
}

export async function findHaloRpcFileFromEnv() {
  return await findHaloRpcFile({
    rpcFile: process.env.HALO_RPC_FILE,
    userDataDir: process.env.HALO_USER_DATA,
    cwd: process.cwd(),
    homeDir: homedir(),
    platform: process.platform,
    appData: process.env.APPDATA,
  });
}

function platformRpcFile(args: FindHaloRpcFileArgs) {
  if (args.platform === "darwin") {
    return rpcFilePath(
      join(args.homeDir, "Library", "Application Support", "Halo"),
    );
  }
  if (args.platform === "linux") {
    return rpcFilePath(join(args.homeDir, ".config", "Halo"));
  }
  if (args.platform === "win32" && args.appData !== undefined) {
    return rpcFilePath(join(args.appData, "Halo"));
  }
  return undefined;
}

function walkUpRpcFile(cwd: string) {
  let directory = cwd;
  while (true) {
    const candidate = rpcFilePath(join(directory, ".halo"));
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
