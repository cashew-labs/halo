import { readFile } from "node:fs/promises";
import { Cli, z } from "incur";
import * as errore from "errore";
import type { HaloClient } from "@get-halo/client";
import { connectHalo, type HaloRpcEnv } from "./connectHalo.js";

class BrowserCommandError extends errore.createTaggedError({
  name: "BrowserCommandError",
  message: "$detail",
}) {}

const env = z.object({
  HALO_RPC_FILE: z.string().optional(),
  HALO_USER_DATA: z.string().optional(),
});
const id = z.string().describe("Browser ID returned by open or list");
const source = z
  .string()
  .optional()
  .describe(
    "Async function body with Playwright page in scope; return a value to inspect it",
  );
const scriptOptions = z.object({
  file: z.string().optional().describe("Read the script from a file"),
  stdin: z.boolean().optional().describe("Read the script from stdin"),
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
    return new BrowserCommandError({
      detail: "Pass a script argument, --file, or --stdin (exactly one).",
    });
  if (input.source !== undefined) return input.source;
  if (input.file !== undefined)
    return await readFile(input.file, "utf8").catch(
      (cause) => new BrowserCommandError({ detail: "Read script file", cause }),
    );
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function request<T>(
  environment: HaloRpcEnv,
  run: (client: HaloClient) => Promise<T>,
) {
  const connected = await connectHalo(environment);
  if (connected instanceof Error) return connected;
  return await run(connected.client).catch(
    (cause) => new BrowserCommandError({ detail: cause.message, cause }),
  );
}

export const browser = Cli.create("browser", {
  description:
    "Access URLs in private browser sessions; browser state survives exec calls",
})
  .command("open", {
    description:
      "Open a URL in a new isolated browser; Halo installs Chromium once if needed",
    args: z.object({ url: z.string().url() }),
    env,
    async run(c) {
      const result = await request(
        c.env,
        async (client) => await client.browser.open(c.args),
      );
      if (result instanceof Error)
        return c.error({ code: "BROWSER", message: result.message });
      return c.ok(result);
    },
  })
  .command("list", {
    description: "List this workspace's open browsers",
    env,
    async run(c) {
      const result = await request(
        c.env,
        async (client) => await client.browser.list(),
      );
      if (result instanceof Error)
        return c.error({ code: "BROWSER", message: result.message });
      return c.ok(result);
    },
  })
  .command("exec", {
    description: "Run Playwright code in an existing browser",
    args: z.object({ id, source }),
    options: scriptOptions,
    env,
    async run(c) {
      const code = await readSource({ ...c.args, ...c.options });
      if (code instanceof Error)
        return c.error({ code: "BROWSER", message: code.message });
      if (code.trim().length === 0)
        return c.error({
          code: "BROWSER",
          message: "The script cannot be empty.",
        });
      const result = await request(
        c.env,
        async (client) =>
          await client.browser.exec({ id: c.args.id, source: code }),
      );
      if (result instanceof Error)
        return c.error({ code: "BROWSER", message: result.message });
      return c.ok(result);
    },
  })
  .command("snapshot", {
    description: "Read the page's accessibility tree and runtime errors",
    args: z.object({ id }),
    env,
    async run(c) {
      const result = await request(
        c.env,
        async (client) => await client.browser.snapshot(c.args),
      );
      if (result instanceof Error)
        return c.error({ code: "BROWSER", message: result.message });
      return c.ok(result);
    },
  })
  .command("screenshot", {
    description: "Save a PNG in the workspace and return its path",
    args: z.object({ id }),
    env,
    async run(c) {
      const result = await request(
        c.env,
        async (client) => await client.browser.screenshot(c.args),
      );
      if (result instanceof Error)
        return c.error({ code: "BROWSER", message: result.message });
      return c.ok(result);
    },
  })
  .command("close", {
    description: "Close a private browser and release its process",
    args: z.object({ id }),
    env,
    async run(c) {
      const result = await request(
        c.env,
        async (client) => await client.browser.close(c.args),
      );
      if (result instanceof Error)
        return c.error({ code: "BROWSER", message: result.message });
      return c.ok({ closed: c.args.id });
    },
  });
