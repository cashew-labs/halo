import { createORPCClient } from "@orpc/client";
import type { HaloClient } from "@get-halo/client";
import type {
  readFile,
  runBash,
  writeFile,
} from "@get-halo/workspace-server/filesystem";

type HarnessBashInput = Pick<
  Parameters<typeof runBash>[1],
  "command" | "cwd" | "timeoutMs"
>;

type RemoteHarnessTools = {
  bash: {
    run(
      input: HarnessBashInput,
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

type HarnessTools = Omit<RemoteHarnessTools, "bash"> & {
  bash: {
    run(input: HarnessBashInput): Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>;
  };
};

export function createHarnessTools(
  client: HaloClient["testApi"],
): HarnessTools {
  const remote = createORPCClient<RemoteHarnessTools>({
    async call(path, input, options) {
      return await client.invokeTool(
        { path: path.join("."), input },
        { signal: options.signal },
      );
    },
  });
  return {
    ...remote,
    bash: {
      async run(input) {
        const result = await remote.bash.run(input);
        if (result.truncated)
          return {
            code: result.code,
            stdout: `${result.head}\n[Full output: ${result.fullOutputPath}]\n${result.tail}`,
            stderr: "",
          };
        return result;
      },
    },
  };
}
