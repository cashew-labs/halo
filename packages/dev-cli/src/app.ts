import fs from "node:fs/promises";
import { Cli, z } from "incur";
import * as errore from "errore";
import type { AppControlClient } from "@get-halo/app-control";
import { connectAppControl, type AppControlEnv } from "./connectAppControl.js";

class AppCommandError extends errore.createTaggedError({
  name: "AppCommandError",
  message: "$detail",
}) {}

const env = z.object({
  HALO_APP_CONTROL_FILE: z
    .string()
    .optional()
    .describe("Path to appControl.json"),
  HALO_USER_DATA: z
    .string()
    .optional()
    .describe("Electron's local application data directory"),
});

async function readSource(input: {
  source?: string;
  file?: string;
  stdin?: boolean;
}) {
  const count =
    Number(input.source !== undefined) +
    Number(input.file !== undefined) +
    Number(input.stdin === true);
  if (count !== 1)
    return new AppCommandError({
      detail: "Pass a script argument, --file, or --stdin (exactly one).",
    });
  if (input.source !== undefined) return input.source;
  if (input.file !== undefined)
    return await fs
      .readFile(input.file, "utf8")
      .catch(
        (cause) => new AppCommandError({ detail: "Read script file", cause }),
      );
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function request<T>(
  environment: AppControlEnv,
  run: (client: AppControlClient) => Promise<T>,
) {
  const client = await connectAppControl(environment);
  if (client instanceof Error) return client;
  return await run(client).catch(
    (cause) => new AppCommandError({ detail: cause.message, cause }),
  );
}

export const app = Cli.create("app", {
  description: "Control the running Halo debug renderer",
})
  .command("exec", {
    description: "Run Playwright code against Halo's renderer",
    args: z.object({
      source: z
        .string()
        .optional()
        .describe("Async function body with Playwright page in scope"),
    }),
    options: z.object({
      file: z.string().optional().describe("Read the script from a file"),
      stdin: z.boolean().optional().describe("Read the script from stdin"),
    }),
    env,
    async run(c) {
      const source = await readSource({ ...c.args, ...c.options });
      if (source instanceof Error)
        return c.error({ code: "APP_CONTROL", message: source.message });
      if (source.trim().length === 0)
        return c.error({
          code: "APP_CONTROL",
          message: "The script cannot be empty.",
        });
      const result = await request(
        c.env,
        async (client) => await client.exec({ source }),
      );
      if (result instanceof Error)
        return c.error({ code: "APP_CONTROL", message: result.message });
      return c.ok(result);
    },
  })
  .command("snapshot", {
    description: "Read Halo's accessibility tree",
    env,
    async run(c) {
      const result = await request(
        c.env,
        async (client) => await client.snapshot(),
      );
      if (result instanceof Error)
        return c.error({ code: "APP_CONTROL", message: result.message });
      return c.ok(result);
    },
  })
  .command("screenshot", {
    description: "Save a screenshot in Electron's local app data directory",
    env,
    async run(c) {
      const result = await request(
        c.env,
        async (client) => await client.screenshot(),
      );
      if (result instanceof Error)
        return c.error({ code: "APP_CONTROL", message: result.message });
      return c.ok(result);
    },
  });
