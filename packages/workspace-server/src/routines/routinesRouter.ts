import { implement } from "@orpc/server";
import { contract, type RoutineRun } from "@get-halo/client";
import { orpcErrors } from "../orpcErrors.js";
import type { RoutineRunner } from "./RoutineRunner.js";
import type { RoutineService } from "./RoutineService.js";

export type RoutinesRouterContext = {
  routines: RoutineService;
  routineRunner: RoutineRunner;
};
const os = implement(contract.routines).$context<RoutinesRouterContext>();
export const routinesRouter = os.router({
  list: os.list.handler(({ context }) => context.routines.list()),
  watch: os.watch.handler(({ context, signal }) =>
    context.routines.watch(signal),
  ),
  save: os.save.handler(async ({ context, input }) => {
    const saved = await context.routines.save(input);
    if (saved instanceof Error) return orpcErrors.badRequest(saved);
    return saved;
  }),
  remove: os.remove.handler(async ({ context, input }) => {
    const removed = await context.routines.remove(input.routineId);
    if (removed instanceof Error) return orpcErrors.badRequest(removed);
  }),
  setEnabled: os.setEnabled.handler(async ({ context, input }) => {
    const updated = await context.routines.setEnabled(input);
    if (updated instanceof Error) return orpcErrors.badRequest(updated);
    return updated;
  }),
  runNow: os.runNow.handler(async ({ context, input }) => {
    const run = await context.routineRunner.start({
      routineId: input.routineId,
      trigger: "manual",
    });
    if (run instanceof Error) return orpcErrors.badRequest(run);
    // SAFETY: Only a scheduled trigger can find no due occurrence.
    return run as RoutineRun;
  }),
  listRuns: os.listRuns.handler(async ({ context, input }) => {
    const runs = await context.routines.listRuns(input);
    if (runs instanceof Error) return orpcErrors.badRequest(runs);
    return runs;
  }),
});
