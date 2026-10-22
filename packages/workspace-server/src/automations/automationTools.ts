import { Type } from "@sinclair/typebox";
import {
  automationInputSchema,
  InvalidAutomationError,
} from "@get-halo/client";
import { haloTool } from "../agent/tools/HaloTool.js";

const automationIdSchema = Type.Object({
  automationId: Type.String({ minLength: 1 }),
});

export const automationTools = {
  gmailConnections: haloTool({
    description:
      "List the user's saved Gmail accounts and connectionAddress values for a Gmail trigger. If none exist, use the connection setup tools to connect Gmail, then list again. Halo manages Pub/Sub and watch renewal; users do not need a GCP project.",
    inputSchema: Type.Object({}),
    requiredCapabilities: ["workspace.automations"],
    execute: async (_input, ctx) => {
      const connections =
        await ctx.services.automationSources.gmailConnections();
      if (connections instanceof Error) return connections;
      return { result: connections };
    },
  }),
  webhookAccess: haloTool({
    description:
      "Reveal the private URL and bearer token for a webhook automation. When giving the user the webhook URL, use the complete returned url, including its ?token= query parameter, as one copyable URL; do not separate the token from the URL. Set rotate:true to revoke the old token immediately. Treat the URL and token as credentials: give them only to the user or the service they authorize. Call after saving a webhook trigger to finish setup.",
    inputSchema: Type.Object({
      automationId: Type.String({ minLength: 1 }),
      rotate: Type.Optional(Type.Boolean()),
    }),
    requiredCapabilities: ["workspace.automations"],
    execute: async (input, ctx) => {
      const access = await ctx.services.automationSources.webhookAccess(input);
      if (access instanceof Error) return access;
      return { result: access };
    },
  }),
  sourceStatus: haloTool({
    description:
      "Synchronize a trigger registration and report its control-plane setup status, errors, and recent deliveries. Check this after saving a Gmail or webhook trigger before saying it is live.",
    inputSchema: automationIdSchema,
    requiredCapabilities: ["workspace.automations"],
    execute: async ({ automationId }, ctx) => {
      const state = await ctx.services.automationSources.status(automationId);
      if (state instanceof Error) return state;
      return { result: state };
    },
  }),
  list: haloTool({
    description:
      "List automation definitions, activation configuration, enabled state, and latest run. Routines and event triggers share this namespace.",
    inputSchema: Type.Object({}),
    requiredCapabilities: ["workspace.automations"],
    execute: async (_input, ctx) => ({
      result: ctx.services.automations.list(),
    }),
  }),
  save: haloTool({
    description:
      "Create or update an automation. Omit id to create; include an ID from list to replace a definition. Choose activation.type routine with a five-field cron and IANA timezone, or trigger with webhook or Gmail. Gmail requires a connectionAddress from gmailConnections, messageReceived, and optional exact sender/subject substring filters. Actions run a saved agent prompt or shell command in a new thread. Agent prompts must include all needed context. Event data is JSON in HALO_AUTOMATION_EVENT_FILE for scripts and a referenced file for agents; never interpolate event data into commands. Saving does not run the action. Editing cancels queued runs from the previous definition; an active run finishes its saved action. External trigger setup also requires control-plane registration; check source status before claiming it is live.",
    inputSchema: automationInputSchema,
    requiredCapabilities: ["workspace.automations"],
    execute: async (input, ctx) => {
      const saved = await ctx.services.automations.save(input);
      if (saved instanceof Error) return saved;
      return { result: saved };
    },
  }),
  pause: haloTool({
    description:
      "Pause future activations and cancel queued runs. An active action finishes.",
    inputSchema: automationIdSchema,
    requiredCapabilities: ["workspace.automations"],
    execute: async (input, ctx) => {
      const updated = await ctx.services.automations.setEnabled({
        ...input,
        enabled: false,
      });
      if (updated instanceof Error) return updated;
      return { result: updated };
    },
  }),
  resume: haloTool({
    description: "Resume future activations without replaying missed events.",
    inputSchema: automationIdSchema,
    requiredCapabilities: ["workspace.automations"],
    execute: async (input, ctx) => {
      const updated = await ctx.services.automations.setEnabled({
        ...input,
        enabled: true,
      });
      if (updated instanceof Error) return updated;
      return { result: updated };
    },
  }),
  remove: haloTool({
    description:
      "Delete an automation and its run index. Existing thread transcripts remain.",
    inputSchema: automationIdSchema,
    requiredCapabilities: ["workspace.automations"],
    execute: async ({ automationId }, ctx) => {
      const removed = await ctx.services.automations.remove(automationId);
      if (removed instanceof Error) return removed;
      return { result: { removed: automationId } };
    },
  }),
  run: haloTool({
    description:
      "Run the saved action once now, including when paused, without changing its activation. Queues behind an active run of the same automation. Optional samplePayload supplies test JSON for a trigger, including when paused.",
    inputSchema: Type.Object({
      automationId: Type.String({ minLength: 1 }),
      samplePayload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    requiredCapabilities: ["workspace.automations"],
    execute: async (input, ctx) => {
      const run = await ctx.services.automationRunner.start({
        ...input,
        trigger: "manual",
      });
      if (run instanceof Error) return run;
      if (run === undefined)
        return new InvalidAutomationError({
          reason: "Manual run was not accepted",
        });
      return { result: run };
    },
  }),
  history: haloTool({
    description:
      "List recent automation runs, including queued deliveries, errors, and thread links.",
    inputSchema: Type.Object({
      automationId: Type.String({ minLength: 1 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    requiredCapabilities: ["workspace.automations"],
    execute: async (input, ctx) => {
      const runs = await ctx.services.automations.listRuns(input);
      if (runs instanceof Error) return runs;
      return { result: runs };
    },
  }),
};
