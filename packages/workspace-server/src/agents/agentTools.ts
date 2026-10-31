import { Type } from "@sinclair/typebox";
import { newAgentSchema, agentSettingsSchema } from "@get-halo/client";
import { haloTool } from "../agent/tools/HaloTool.js";

export const agentTools = {
  new: haloTool({
    description:
      "Create a named persistent agent with its own instructions and one continuous conversation. Reuse requestId only to retry the same creation. Returns the agent ID and its threadId; use thread.prompt to send a message. For a one-off task, use thread.new instead.",
    inputSchema: newAgentSchema,
    requiredCapabilities: ["workspace.threads.write"],
    execute: async (input, context) => {
      const agent = await context.services.agents.new(input);
      if (agent instanceof Error) return agent;
      return { result: agent };
    },
  }),
  list: haloTool({
    description:
      "List persistent agents, their instructions, and their backing thread IDs.",
    inputSchema: Type.Object({}),
    requiredCapabilities: ["workspace.threads.read"],
    execute: async (_input, context) => {
      const agents = await context.services.agents.list();
      if (agents instanceof Error) return agents;
      return { result: agents };
    },
  }),
  update: haloTool({
    description:
      "Update an agent's name and instructions without changing its conversation history. Instructions apply at the next model request, not to a request already running. Use an agent ID from agents.list, not a thread ID.",
    inputSchema: agentSettingsSchema,
    requiredCapabilities: ["workspace.threads.write"],
    execute: async (input, context) => {
      const agent = await context.services.agents.update(input);
      if (agent instanceof Error) return agent;
      return { result: agent };
    },
  }),
};
