import type { AutomationSources } from "./AutomationSources.js";
import { implement } from "@orpc/server";
import { contract } from "@get-halo/client";
import { orpcErrors } from "../orpcErrors.js";
import type { RoutinesRouterContext } from "../routines/routinesRouter.js";

export type AutomationsRouterContext = RoutinesRouterContext & {
  automationSources: AutomationSources;
};
const os = implement(contract.automations).$context<AutomationsRouterContext>();
export const automationsRouter = os.router({
  gmailConnections: os.gmailConnections.handler(async ({ context }) => {
    const connections = await context.automationSources.gmailConnections();
    if (connections instanceof Error) return orpcErrors.badRequest(connections);
    return connections;
  }),
  webhookAccess: os.webhookAccess.handler(async ({ context, input }) => {
    const access = await context.automationSources.webhookAccess(input);
    if (access instanceof Error) return orpcErrors.badRequest(access);
    return access;
  }),
  sourceStatus: os.sourceStatus.handler(async ({ context, input }) => {
    const state = await context.automationSources.status(input.automationId);
    if (state instanceof Error) return orpcErrors.badRequest(state);
    return state;
  }),
  runNow: os.runNow.handler(async ({ context, input }) => {
    const run = await context.routineRunner.automations.start({
      ...input,
      trigger: "manual",
    });
    if (run instanceof Error) return orpcErrors.badRequest(run);
    if (run === undefined)
      return orpcErrors.badRequest(new Error("Manual run was not accepted"));
    return run;
  }),
  runScheduled: os.runScheduled.handler(async ({ context, input }) => {
    const run = await context.routineRunner.automations.start({
      ...input,
      trigger: "schedule",
    });
    if (run instanceof Error) return orpcErrors.badRequest(run);
  }),
  acceptEvent: os.acceptEvent.handler(async ({ context, input }) => {
    const run = await context.routineRunner.automations.acceptEvent(input);
    if (run instanceof Error) return orpcErrors.badRequest(run);
    return run;
  }),
  list: os.list.handler(({ context }) => context.routines.automations.list()),
  watch: os.watch.handler(({ context, signal }) =>
    context.routines.automations.watch(signal),
  ),
  save: os.save.handler(async ({ context, input }) => {
    const saved = await context.routines.automations.save(input);
    if (saved instanceof Error) return orpcErrors.badRequest(saved);
    return saved;
  }),
  remove: os.remove.handler(async ({ context, input }) => {
    const removed = await context.routines.automations.remove(
      input.automationId,
    );
    if (removed instanceof Error) return orpcErrors.badRequest(removed);
  }),
  setEnabled: os.setEnabled.handler(async ({ context, input }) => {
    const updated = await context.routines.automations.setEnabled(input);
    if (updated instanceof Error) return orpcErrors.badRequest(updated);
    return updated;
  }),
  listRuns: os.listRuns.handler(async ({ context, input }) => {
    const runs = await context.routines.automations.listRuns(input);
    if (runs instanceof Error) return orpcErrors.badRequest(runs);
    return runs;
  }),
});
