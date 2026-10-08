import type { AutomationRunner } from "../automations/AutomationRunner.js";
import { asRoutineRun, type RoutineService } from "./RoutineService.js";

/** Legacy schedule dispatch uses the same runner as trigger activations. */
export class RoutineRunner {
  readonly automations: AutomationRunner;
  private readonly routines: RoutineService;
  constructor(ctx: {
    automations: AutomationRunner;
    routines: RoutineService;
  }) {
    this.automations = ctx.automations;
    this.routines = ctx.routines;
  }
  async start(input: { routineId: string; trigger: "schedule" | "manual" }) {
    const routine = this.routines.get(input.routineId);
    if (routine instanceof Error) return routine;
    const run = await this.automations.start({
      automationId: input.routineId,
      trigger: input.trigger,
    });
    if (run instanceof Error || run === undefined) return run;
    return asRoutineRun(run);
  }
}
