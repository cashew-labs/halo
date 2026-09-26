import { Cli, z } from "incur";
import * as errore from "errore";
import type { HaloClient, RoutineAction } from "@get-halo/client";
import { connectHalo, type HaloRpcEnv } from "./connectHalo.js";

class RoutineCommandError extends errore.createTaggedError({
  name: "RoutineCommandError",
  message: "$detail",
}) {}

const env = z.object({
  HALO_RPC_FILE: z.string().optional(),
  HALO_USER_DATA: z.string().optional(),
});
const routineId = z.object({
  routineId: z.string().describe("Routine ID from `halo routine list`"),
});
const describe = {
  name: "Short name, such as 'Book haircut'",
  cron: "Five-field cron schedule: minute hour day-of-month month day-of-week, such as '0 8 * * 1-5'",
  timezone: "IANA time zone for the schedule, such as America/New_York",
  prompt: "Run the agent with this prompt",
  command: "Run this shell command instead of the agent; no model call",
  cwd: "Workspace-relative working directory for --command; defaults to the extension directory",
};
const actionOptions = {
  prompt: z.string().optional().describe(describe.prompt),
  command: z.string().optional().describe(describe.command),
  cwd: z.string().optional().describe(describe.cwd),
};

async function request<T>(
  environment: HaloRpcEnv,
  run: (client: HaloClient) => Promise<T>,
) {
  const connected = await connectHalo(environment);
  if (connected instanceof Error) return connected;
  return await run(connected.client).catch(
    (cause) => new RoutineCommandError({ detail: cause.message, cause }),
  );
}

function readAction(options: {
  prompt?: string;
  command?: string;
  cwd?: string;
}): RoutineAction | RoutineCommandError | undefined {
  if (options.prompt !== undefined && options.command !== undefined)
    return new RoutineCommandError({
      detail: "Pass either --prompt or --command, not both.",
    });
  if (options.prompt !== undefined) {
    if (options.cwd !== undefined)
      return new RoutineCommandError({
        detail: "--cwd applies only to --command routines.",
      });
    return { type: "runAgent", prompt: options.prompt };
  }
  if (options.command !== undefined)
    return { type: "runScript", command: options.command, cwd: options.cwd };
  if (options.cwd !== undefined)
    return new RoutineCommandError({ detail: "Pass --cwd with --command." });
}

export const routine = Cli.create("routine", {
  description:
    "Schedule extension routines that run an agent prompt or a shell command; each run opens a new session",
})
  .command("list", {
    description: "List routines with their schedules, next run, and last run",
    options: z.object({
      extension: z
        .string()
        .optional()
        .describe("Only this extension's routines"),
    }),
    env,
    async run(c) {
      const routines = await request(
        c.env,
        async (client) => await client.routines.list(),
      );
      if (routines instanceof Error)
        return c.error({ code: "ROUTINE", message: routines.message });
      return c.ok(
        routines.filter(
          (item) =>
            c.options.extension === undefined ||
            item.extensionId === c.options.extension,
        ),
      );
    },
  })
  .command("add", {
    description:
      "Add a routine to an extension. Pass --prompt for an agent run or --command for a script",
    args: z.object({
      extensionId: z
        .string()
        .describe("Extension that owns the routine, such as appointments"),
    }),
    options: z.object({
      name: z.string().describe(describe.name),
      cron: z.string().describe(describe.cron),
      timezone: z
        .string()
        .optional()
        .describe(`${describe.timezone}; defaults to this machine's time zone`),
      ...actionOptions,
      paused: z.boolean().optional().describe("Create the routine paused"),
    }),
    env,
    async run(c) {
      const action = readAction(c.options);
      if (action instanceof Error)
        return c.error({ code: "ROUTINE", message: action.message });
      if (action === undefined)
        return c.error({
          code: "ROUTINE",
          message: "Pass --prompt for an agent run or --command for a script.",
        });
      const saved = await request(
        c.env,
        async (client) =>
          await client.routines.save({
            extensionId: c.args.extensionId,
            name: c.options.name,
            cron: c.options.cron,
            timezone:
              c.options.timezone ??
              Intl.DateTimeFormat().resolvedOptions().timeZone,
            action,
            enabled: c.options.paused !== true,
          }),
      );
      if (saved instanceof Error)
        return c.error({ code: "ROUTINE", message: saved.message });
      return c.ok(saved);
    },
  })
  .command("update", {
    description:
      "Change a routine's name, schedule, time zone, or action; past runs keep their sessions",
    args: routineId,
    options: z.object({
      name: z.string().optional().describe(describe.name),
      cron: z.string().optional().describe(describe.cron),
      timezone: z.string().optional().describe(describe.timezone),
      ...actionOptions,
    }),
    env,
    async run(c) {
      const action = readAction(c.options);
      if (action instanceof Error)
        return c.error({ code: "ROUTINE", message: action.message });
      const saved = await request(c.env, async (client) => {
        const existing = (await client.routines.list()).find(
          (item) => item.id === c.args.routineId,
        );
        if (existing === undefined)
          return new RoutineCommandError({
            detail: `Routine '${c.args.routineId}' does not exist. List routines to find its ID.`,
          });
        return await client.routines.save({
          id: existing.id,
          extensionId: existing.extensionId,
          name: c.options.name ?? existing.name,
          cron: c.options.cron ?? existing.cron,
          timezone: c.options.timezone ?? existing.timezone,
          action: action ?? existing.action,
        });
      });
      if (saved instanceof Error)
        return c.error({ code: "ROUTINE", message: saved.message });
      return c.ok(saved);
    },
  })
  .command("remove", {
    description: "Remove a routine; sessions from its past runs stay",
    args: routineId,
    env,
    async run(c) {
      const removed = await request(
        c.env,
        async (client) => await client.routines.remove(c.args),
      );
      if (removed instanceof Error)
        return c.error({ code: "ROUTINE", message: removed.message });
      return c.ok({ routineId: c.args.routineId });
    },
  })
  .command("pause", {
    description: "Stop scheduling a routine until it is resumed",
    args: routineId,
    env,
    async run(c) {
      const paused = await request(
        c.env,
        async (client) =>
          await client.routines.setEnabled({ ...c.args, enabled: false }),
      );
      if (paused instanceof Error)
        return c.error({ code: "ROUTINE", message: paused.message });
      return c.ok(paused);
    },
  })
  .command("resume", {
    description:
      "Schedule a paused routine again from now; missed runs are skipped",
    args: routineId,
    env,
    async run(c) {
      const resumed = await request(
        c.env,
        async (client) =>
          await client.routines.setEnabled({ ...c.args, enabled: true }),
      );
      if (resumed instanceof Error)
        return c.error({ code: "ROUTINE", message: resumed.message });
      return c.ok(resumed);
    },
  })
  .command("run", {
    description:
      "Start a routine now in a new session without changing its schedule",
    args: routineId,
    env,
    async run(c) {
      const run = await request(
        c.env,
        async (client) => await client.routines.runNow(c.args),
      );
      if (run instanceof Error)
        return c.error({ code: "ROUTINE", message: run.message });
      return c.ok(run);
    },
  })
  .command("history", {
    description:
      "List a routine's recent runs, newest first, with status and session ID",
    args: routineId,
    options: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(20),
    }),
    env,
    async run(c) {
      const runs = await request(
        c.env,
        async (client) =>
          await client.routines.listRuns({
            routineId: c.args.routineId,
            limit: c.options.limit,
          }),
      );
      if (runs instanceof Error)
        return c.error({ code: "ROUTINE", message: runs.message });
      return c.ok(runs);
    },
  });
