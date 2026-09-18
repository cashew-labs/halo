import { createORPCClient } from "@orpc/client";
import type { HaloClient } from "@get-halo/client";
import type {
  readFile,
  runBash,
  writeFile,
} from "@get-halo/workspace-server/filesystem";

type HarnessTools = {
  bash: {
    run(
      input: Omit<Parameters<typeof runBash>[1], "signal">,
    ): Promise<Exclude<Awaited<ReturnType<typeof runBash>>, Error>>;
  };
  files: {
    read(
      input: Parameters<typeof readFile>[0]["input"],
    ): Promise<Exclude<Awaited<ReturnType<typeof readFile>>, Error>>;
    write(
      input: Parameters<typeof writeFile>[0]["input"],
    ): Promise<Exclude<Awaited<ReturnType<typeof writeFile>>, Error>>;
  };
};

export function createHarnessTools(
  client: HaloClient["testApi"],
): HarnessTools {
  return createORPCClient<HarnessTools>({
    async call(path, input, options) {
      return await client.invokeTool(
        { path: path.join("."), input },
        { signal: options.signal },
      );
    },
  });
}
