import { createORPCClient } from "@orpc/client";
import type { HaloClient } from "@get-halo/client";
import type {
  readFile,
  writeFile,
} from "@get-halo/workspace-server/filesystem";
import type { runBash } from "../../workspace-server/src/agent/tools/bash/run.js";

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

export function createHarnessTools(getClient: () => HaloClient): HarnessTools {
  return createORPCClient<HarnessTools>({
    async call(path, input, options) {
      return await getClient().testHarness.invokeTool(
        { path: path.join("."), input },
        { signal: options.signal },
      );
    },
  });
}
