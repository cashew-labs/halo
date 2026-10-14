import { readFile } from "node:fs/promises";
import { Cli, z } from "incur";
import * as errore from "errore";
import type { AppActionBinding, HaloClient } from "@get-halo/client";
import { connectHalo, type HaloRpcEnv } from "./connectHalo.js";

class AppCommandError extends errore.createTaggedError({
  name: "AppCommandError",
  message: "$detail",
}) {}

const env = z.object({
  HALO_RPC_FILE: z.string().optional(),
  HALO_USER_DATA: z.string().optional(),
});
const appId = z.string().uuid().describe("App ID from `halo app list`");

async function request<T>(
  environment: HaloRpcEnv,
  run: (client: HaloClient) => Promise<T>,
) {
  const connected = await connectHalo(environment);
  if (connected instanceof Error) return connected;
  return await run(connected.client).catch(
    (cause) => new AppCommandError({ detail: cause.message, cause }),
  );
}

async function readText(file: string) {
  return await readFile(file, "utf8").catch(
    (cause) => new AppCommandError({ detail: `Read ${file}`, cause }),
  );
}

export const app = Cli.create("app", {
  description:
    "Publish extensions as shared apps and edit, build or restart them on their app VM",
})
  .command("list", {
    description: "List your published apps with their links and access",
    env,
    async run(c) {
      const apps = await request(
        c.env,
        async (client) => await client.apps.list(),
      );
      if (apps instanceof Error)
        return c.error({ code: "APP", message: apps.message });
      return c.ok(apps);
    },
  })
  .command("publish", {
    description:
      "Move an extension to its own app VM and share it; the local copy becomes a link",
    args: z.object({ extensionId: z.string().regex(/^[a-z][a-z0-9-]*$/) }),
    options: z.object({
      slug: z.string().optional().describe("Link path; defaults to the ID"),
      invite: z
        .array(z.string().email())
        .optional()
        .describe("Halo account emails; omit to share with anyone"),
    }),
    env,
    async run(c) {
      const members = c.options.invite ?? [];
      const published = await request(
        c.env,
        async (client) =>
          await client.apps.publish({
            extensionId: c.args.extensionId,
            slug: c.options.slug,
            access: {
              visibility: members.length === 0 ? "public" : "invited",
              members,
            },
          }),
      );
      if (published instanceof Error)
        return c.error({ code: "APP", message: published.message });
      return c.ok(published);
    },
  })
  .command("unpublish", {
    description: "Stop sharing an app; it keeps running for you",
    args: z.object({ appId }),
    env,
    async run(c) {
      const updated = await request(
        c.env,
        async (client) =>
          await client.apps.update({ appId: c.args.appId, published: false }),
      );
      if (updated instanceof Error)
        return c.error({ code: "APP", message: updated.message });
      return c.ok(updated);
    },
  })
  .command("cancel", {
    description:
      "Undo a publication that failed before reaching its app VM; the extension runs locally again",
    args: z.object({ appId }),
    env,
    async run(c) {
      const cancelled = await request(
        c.env,
        async (client) => await client.apps.cancel({ appId: c.args.appId }),
      );
      if (cancelled instanceof Error)
        return c.error({ code: "APP", message: cancelled.message });
      return c.ok({ cancelled: c.args.appId });
    },
  })
  .command("read", {
    description: "Read a source file from the app VM",
    args: z.object({ appId, path: z.string() }),
    env,
    async run(c) {
      const source = await request(
        c.env,
        async (client) =>
          await client.apps.readSource({
            appId: c.args.appId,
            name: c.args.path,
          }),
      );
      if (source instanceof Error)
        return c.error({ code: "APP", message: source.message });
      return c.ok(source);
    },
  })
  .command("write", {
    description: "Replace a source file on the app VM with a local file",
    args: z.object({ appId, path: z.string() }),
    options: z.object({ file: z.string().describe("Local file to upload") }),
    env,
    async run(c) {
      const contents = await readText(c.options.file);
      if (contents instanceof Error)
        return c.error({ code: "APP", message: contents.message });
      const written = await request(
        c.env,
        async (client) =>
          await client.apps.writeSource({
            appId: c.args.appId,
            name: c.args.path,
            contents,
          }),
      );
      if (written instanceof Error)
        return c.error({ code: "APP", message: written.message });
      return c.ok({ written: c.args.path });
    },
  })
  .command("exec", {
    description:
      "Run a build command in the app VM's build sandbox (no app data), then restart",
    args: z.object({ appId, command: z.string() }),
    env,
    async run(c) {
      const executed = await request(
        c.env,
        async (client) =>
          await client.apps.execSource({
            appId: c.args.appId,
            command: c.args.command,
          }),
      );
      if (executed instanceof Error)
        return c.error({ code: "APP", message: executed.message });
      return c.ok(executed);
    },
  })
  .command("restart", {
    description: "Restart the app's backend on its app VM",
    args: z.object({ appId }),
    env,
    async run(c) {
      const restarted = await request(
        c.env,
        async (client) => await client.apps.restart({ appId: c.args.appId }),
      );
      if (restarted instanceof Error)
        return c.error({ code: "APP", message: restarted.message });
      return c.ok({ restarted: c.args.appId });
    },
  })
  .command("bind-actions", {
    description:
      "Replace the app's fixed integration requests from a JSON array of actions",
    args: z.object({ appId }),
    options: z.object({ file: z.string().describe("JSON file of actions") }),
    env,
    async run(c) {
      const text = await readText(c.options.file);
      if (text instanceof Error)
        return c.error({ code: "APP", message: text.message });
      const actions = errore.try({
        // SAFETY: The control plane validates every action before storing it.
        try: () => JSON.parse(text) as AppActionBinding[],
        catch: (cause) =>
          new AppCommandError({ detail: "Actions file is not JSON", cause }),
      });
      if (actions instanceof Error)
        return c.error({ code: "APP", message: actions.message });
      const bound = await request(
        c.env,
        async (client) =>
          await client.apps.bindActions({ appId: c.args.appId, actions }),
      );
      if (bound instanceof Error)
        return c.error({ code: "APP", message: bound.message });
      return c.ok(bound);
    },
  });
