import { Type } from "@sinclair/typebox";
import {
  automationInputSchema,
  InvalidAutomationError,
} from "@get-halo/client";
import {
  defineHaloTool,
  type HaloToolPlugin,
} from "../agent/tools/HaloToolPlugin.js";
import type { AutomationService } from "./AutomationService.js";
import type { AutomationRunner } from "./AutomationRunner.js";

const automationIdSchema = Type.Object({
  automationId: Type.String({ minLength: 1 }),
});

// Resolve the runner on invocation: agent sessions borrow the tool runtime at startup.
export function createAutomationsPlugin(
  services: () => { automations: AutomationService; runner: AutomationRunner },
): HaloToolPlugin {
  return {
    id: "automations",
    name: "Automations",
    tools: [
      defineHaloTool({
        name: "list",
        description:
          "List automation definitions, activation configuration, enabled state, and latest run. Routines and event triggers share this namespace.",
        inputSchema: Type.Object({}),
        requiredCapabilities: ["workspace.automations"],
        execute: async () => ({ value: services().automations.list() }),
      }),
      defineHaloTool({
        name: "save",
        description:
          "Create or update an automation. Omit id to create; include an ID from list to replace a definition. Choose activation.type routine with a five-field cron and IANA timezone, or trigger with webhook or Gmail. Gmail requires an existing connectionAddress, messageReceived, and optional exact sender/subject substring filters. Actions run a saved agent prompt or shell command in a new session. Agent prompts must include all needed context. Event data is JSON in HALO_AUTOMATION_EVENT_FILE for scripts and a referenced file for agents; never interpolate event data into commands. Saving does not run the action. Editing cancels queued runs from the previous definition; an active run finishes its saved action. External trigger setup also requires control-plane registration; check source status before claiming it is live.",
        inputSchema: automationInputSchema,
        requiredCapabilities: ["workspace.automations"],
        execute: async (input) => {
          const saved = await services().automations.save(input);
          if (saved instanceof Error) return saved;
          return { value: saved };
        },
      }),
      ...(["pause", "resume"] as const).map((name) =>
        defineHaloTool({
          name,
          description:
            name === "pause"
              ? "Pause future activations and cancel queued runs. An active action finishes."
              : "Resume future activations without replaying missed events.",
          inputSchema: automationIdSchema,
          requiredCapabilities: ["workspace.automations"],
          execute: async (input) => {
            const updated = await services().automations.setEnabled({
              ...input,
              enabled: name === "resume",
            });
            if (updated instanceof Error) return updated;
            return { value: updated };
          },
        }),
      ),
      defineHaloTool({
        name: "remove",
        description:
          "Delete an automation and its run index. Existing session transcripts remain.",
        inputSchema: automationIdSchema,
        requiredCapabilities: ["workspace.automations"],
        execute: async ({ automationId }) => {
          const removed = await services().automations.remove(automationId);
          if (removed instanceof Error) return removed;
          return { value: { removed: automationId } };
        },
      }),
      defineHaloTool({
        name: "run",
        description:
          "Run the saved action once now, including when paused, without changing its activation. Queues behind an active run of the same automation. No external event data is supplied.",
        inputSchema: automationIdSchema,
        requiredCapabilities: ["workspace.automations"],
        execute: async (input) => {
          const run = await services().runner.start({
            ...input,
            trigger: "manual",
          });
          if (run instanceof Error) return run;
          if (run === undefined)
            return new InvalidAutomationError({
              reason: "Manual run was not accepted",
            });
          return { value: run };
        },
      }),
      defineHaloTool({
        name: "history",
        description:
          "List recent automation runs, including queued deliveries, errors, and session links.",
        inputSchema: Type.Object({
          automationId: Type.String({ minLength: 1 }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
        }),
        requiredCapabilities: ["workspace.automations"],
        execute: async (input) => {
          const runs = await services().automations.listRuns(input);
          if (runs instanceof Error) return runs;
          return { value: runs };
        },
      }),
    ],
  };
}
