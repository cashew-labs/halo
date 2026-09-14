#!/usr/bin/env node

import { Cli, z } from "incur";
import { browser, app } from "./browser.js";
import { extension } from "./extension.js";
import { cliVersion, connectHalo } from "./connectHalo.js";
import { HaloRpcFileError } from "./HaloRpcFile.js";

const haloRpcEnv = z.object({
  HALO_RPC_FILE: z.string().optional().describe("Path to Halo rpc.json"),
  HALO_USER_DATA: z
    .string()
    .optional()
    .describe("Halo userData directory that contains rpc.json"),
});

const workspaceInfo = z.object({
  name: z.string(),
  workspaceRoot: z.string(),
});

const haloVersion = cliVersion();

async function main() {
  await Cli.create("halo", {
    description: "Talk to a running Halo app",
    version: haloVersion === undefined ? "dev" : haloVersion,
  })
    .command("status", {
      description: "Check whether Halo is running and report its workspace",
      env: haloRpcEnv,
      output: z.object({
        protocolVersion: z.number(),
        host: z.literal("127.0.0.1"),
        port: z.number(),
        workspace: workspaceInfo.optional(),
      }),
      async run(c) {
        const connected = await connectHalo(c.env);
        if (connected instanceof Error) {
          return c.error({
            code: "NOT_RUNNING",
            message: connected.message,
          });
        }
        const workspace = await connected.client.workspace
          .get()
          .catch((e) => wrapRpc(e instanceof Error ? e : new Error(String(e))));
        if (workspace instanceof Error) {
          return c.error({
            code: "NOT_RUNNING",
            message: workspace.message,
          });
        }
        return c.ok({
          protocolVersion: connected.serverInfo.protocolVersion,
          host: connected.file.host,
          port: connected.file.port,
          workspace,
        });
      },
    })
    .command(extension)
    .command(browser)
    .command(app)
    .serve();
}

main().catch((cause: unknown) => {
  console.error(cause);
  process.exitCode = 1;
});

function wrapRpc(error: { message: string }) {
  return new HaloRpcFileError({
    detail: error.message,
    cause: error,
  });
}
