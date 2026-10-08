import { Cli, z } from "incur";
import * as errore from "errore";
import { Value } from "@sinclair/typebox/value";
import { automationInputSchema, type HaloClient } from "@get-halo/client";
import { connectHalo, type HaloRpcEnv } from "./connectHalo.js";

class AutomationCommandError extends errore.createTaggedError({
  name: "AutomationCommandError",
  message: "$detail",
}) {}
const env = z.object({
  HALO_RPC_FILE: z.string().optional(),
  HALO_USER_DATA: z.string().optional(),
});
const automationId = z.object({
  automationId: z.string().describe("ID from halo automation list"),
});

async function request<T>(
  environment: HaloRpcEnv,
  run: (client: HaloClient) => Promise<T>,
) {
  const connected = await connectHalo(environment);
  if (connected instanceof Error) return connected;
  return await run(connected.client).catch(
    (cause) => new AutomationCommandError({ detail: cause.message, cause }),
  );
}

export const automation = Cli.create("automation", {
  description: "Manage scheduled routines and event triggers",
})
  .command("list", {
    description: "List automations",
    env,
    async run(c) {
      const result = await request(
        c.env,
        async (client) => await client.automations.list(),
      );
      if (result instanceof Error)
        return c.error({ code: "AUTOMATION", message: result.message });
      return c.ok(result);
    },
  })
  .command("save", {
    description:
      "Create or replace an automation from a JSON definition with name, activation, and action; omit id to create",
    env,
    args: z.object({
      definition: z.string().describe("JSON automation definition"),
    }),
    async run(c) {
      const parsed = errore.try({
        // SAFETY: JSON stays unknown until checked against the public schema.
        try: () => JSON.parse(c.args.definition) as unknown,
        catch: (cause) =>
          new AutomationCommandError({ detail: "Invalid JSON", cause }),
      });
      if (parsed instanceof Error)
        return c.error({ code: "AUTOMATION", message: parsed.message });
      if (!Value.Check(automationInputSchema, parsed))
        return c.error({
          code: "AUTOMATION",
          message: "Invalid automation definition",
        });
      const saved = await request(
        c.env,
        async (client) => await client.automations.save(parsed),
      );
      if (saved instanceof Error)
        return c.error({ code: "AUTOMATION", message: saved.message });
      return c.ok(saved);
    },
  })
  .command("pause", {
    description: "Pause activations and cancel queued runs",
    env,
    args: automationId,
    async run(c) {
      const result = await request(
        c.env,
        async (client) =>
          await client.automations.setEnabled({ ...c.args, enabled: false }),
      );
      if (result instanceof Error)
        return c.error({ code: "AUTOMATION", message: result.message });
      return c.ok(result);
    },
  })
  .command("resume", {
    description: "Resume future activations",
    env,
    args: automationId,
    async run(c) {
      const result = await request(
        c.env,
        async (client) =>
          await client.automations.setEnabled({ ...c.args, enabled: true }),
      );
      if (result instanceof Error)
        return c.error({ code: "AUTOMATION", message: result.message });
      return c.ok(result);
    },
  })
  .command("remove", {
    description: "Delete an automation; preserve its sessions",
    env,
    args: automationId,
    async run(c) {
      const result = await request(
        c.env,
        async (client) => await client.automations.remove(c.args),
      );
      if (result instanceof Error)
        return c.error({ code: "AUTOMATION", message: result.message });
      return c.ok({ removed: c.args.automationId });
    },
  })
  .command("run", {
    description: "Run the saved action once now",
    env,
    args: automationId,
    async run(c) {
      const result = await request(
        c.env,
        async (client) => await client.automations.runNow(c.args),
      );
      if (result instanceof Error)
        return c.error({ code: "AUTOMATION", message: result.message });
      return c.ok(result);
    },
  })
  .command("history", {
    description: "List runs, queued events, and session links",
    env,
    args: automationId,
    async run(c) {
      const result = await request(
        c.env,
        async (client) => await client.automations.listRuns(c.args),
      );
      if (result instanceof Error)
        return c.error({ code: "AUTOMATION", message: result.message });
      return c.ok(result);
    },
  });
