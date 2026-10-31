import { implement } from "@orpc/server";
import { contract } from "@get-halo/client";
import { orpcErrors } from "../orpcErrors.js";
import type { AgentService } from "./AgentService.js";

export type AgentsRouterContext = { agents: AgentService };
const os = implement(contract.agents).$context<AgentsRouterContext>();

export const agentsRouter = os.router({
  new: os.new.handler(async ({ input, context }) => {
    const agent = await context.agents.new(input);
    if (agent instanceof Error) return orpcErrors.badRequest(agent);
    return agent;
  }),
  list: os.list.handler(async ({ context }) => {
    const agents = await context.agents.list();
    if (agents instanceof Error) return orpcErrors.badRequest(agents);
    return agents;
  }),
  update: os.update.handler(async ({ input, context }) => {
    const agent = await context.agents.update(input);
    if (agent instanceof Error) return orpcErrors.badRequest(agent);
    return agent;
  }),
});
