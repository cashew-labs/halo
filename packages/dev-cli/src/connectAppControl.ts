import fs from "node:fs";
import path from "node:path";
import {
  AppControlConnectionError,
  appControlFilePath,
  createAppControlClient,
  readAppControlConnection,
} from "@get-halo/app-control";

export type AppControlEnv = {
  HALO_APP_CONTROL_FILE?: string;
  HALO_USER_DATA?: string;
};

export async function connectAppControl(env: AppControlEnv) {
  const filePath = findAppControlFile(env);
  if (filePath instanceof Error) return filePath;
  const connection = await readAppControlConnection(filePath);
  if (connection instanceof Error) return connection;
  return createAppControlClient({ connection });
}

function findAppControlFile(env: AppControlEnv) {
  if (env.HALO_APP_CONTROL_FILE !== undefined) return env.HALO_APP_CONTROL_FILE;
  if (env.HALO_USER_DATA !== undefined)
    return appControlFilePath(env.HALO_USER_DATA);

  let directory = process.cwd();
  while (true) {
    const candidate = appControlFilePath(path.join(directory, ".halo"));
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory)
      return new AppControlConnectionError({
        detail:
          "start Halo in Electron development mode and set HALO_USER_DATA or HALO_APP_CONTROL_FILE",
      });
    directory = parent;
  }
}
