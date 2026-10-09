import { Value } from "@sinclair/typebox/value";
import { routineInputSchema, InvalidRoutineError } from "@get-halo/client";
import * as errore from "errore";
import type {
  Automation,
  AutomationRun,
  Routine,
  RoutineInput,
  RoutineRun,
  RoutineRunStatus,
} from "@get-halo/client";
import {
  AutomationService,
  AutomationNotFoundError,
} from "../automations/AutomationService.js";
import type { DatabaseClient } from "../storage/DatabaseClient.js";

export class RoutineNotFoundError extends errore.createTaggedError({
  name: "RoutineNotFoundError",
  message: "Routine '$routineId' does not exist. List routines to find its ID.",
}) {}

/** Compatibility surface for extensions and clients that create scheduled routines. */
export class RoutineService {
  readonly automations: AutomationService;

  constructor(ctx: { automations: AutomationService }) {
    this.automations = ctx.automations;
  }

  static async open(ctx: { database: DatabaseClient }) {
    const automations = await AutomationService.open(ctx);
    if (automations instanceof Error) return automations;
    return new RoutineService({ automations });
  }

  list() {
    return this.automations.list().flatMap((automation) => {
      const routine = asRoutine(automation);
      return routine instanceof Error ? [] : [routine];
    });
  }

  get(routineId: string) {
    const automation = this.automations.get(routineId);
    if (automation instanceof Error)
      return new RoutineNotFoundError({ routineId });
    return asRoutine(automation);
  }

  subscribe(listener: (routines: Routine[]) => void) {
    return this.automations.subscribe(() => listener(this.list()));
  }

  async *watch(signal: AbortSignal | undefined) {
    for await (const automations of this.automations.watch(signal)) {
      yield automations.flatMap((automation) => {
        const routine = asRoutine(automation);
        return routine instanceof Error ? [] : [routine];
      });
    }
  }

  async save(input: RoutineInput) {
    if (!Value.Check(routineInputSchema, input))
      return new InvalidRoutineError({ reason: "Invalid routine input" });
    if (input.id !== undefined) {
      const existing = this.get(input.id);
      if (existing instanceof Error) return existing;
    }
    const saved = await this.automations.save({
      ...input,
      activation: {
        type: "routine",
        schedule: { cron: input.cron, timezone: input.timezone },
      },
    });
    if (saved instanceof Error) return saved;
    return asRoutine(saved);
  }

  async setEnabled(input: { routineId: string; enabled: boolean }) {
    const existing = this.get(input.routineId);
    if (existing instanceof Error) return existing;
    const saved = await this.automations.setEnabled({
      automationId: input.routineId,
      enabled: input.enabled,
    });
    if (saved instanceof Error) return saved;
    return asRoutine(saved);
  }

  async remove(routineId: string) {
    const existing = this.get(routineId);
    if (existing instanceof Error) return existing;
    return await this.automations.remove(routineId);
  }

  async listRuns(input: { routineId: string; limit?: number }) {
    const existing = this.get(input.routineId);
    if (existing instanceof Error) return existing;
    const runs = await this.automations.listRuns({
      automationId: input.routineId,
      limit: input.limit,
    });
    if (runs instanceof Error) return runs;
    return runs.flatMap((run) => {
      const routineRun = asRoutineRun(run);
      return routineRun === undefined ? [] : [routineRun];
    });
  }

  async runningSessionIds() {
    return await this.automations.runningSessionIds();
  }
  async recover(options?: { preserveDue?: boolean }) {
    return await this.automations.recover(options);
  }
  async attachSession(input: { runId: string; sessionId: string }) {
    return await this.automations.attachSession(input);
  }
  async finishRun(input: {
    runId: string;
    status: Exclude<RoutineRunStatus, "running" | "skipped">;
    error?: string;
  }) {
    return await this.automations.finishRun(input);
  }

  async beginRun(input: {
    routineId: string;
    trigger: "schedule" | "manual";
    skipReason?: string;
  }) {
    const existing = this.get(input.routineId);
    if (existing instanceof Error) return existing;
    const run = await this.automations.beginRun({
      automationId: input.routineId,
      trigger: input.trigger,
      skipReason: input.skipReason,
    });
    if (run instanceof AutomationNotFoundError)
      return new RoutineNotFoundError({ routineId: input.routineId });
    if (run instanceof Error || run === undefined) return run;
    return asRoutineRun(run);
  }
}

function asRoutine(automation: Automation): Routine | RoutineNotFoundError {
  if (automation.activation.type !== "routine")
    return new RoutineNotFoundError({ routineId: automation.id });
  return {
    ...automation,
    ...automation.activation.schedule,
    lastRun:
      automation.lastRun === undefined
        ? undefined
        : asRoutineRun(automation.lastRun),
  };
}

export function asRoutineRun(run: AutomationRun): RoutineRun | undefined {
  // A trigger converted to a routine keeps its event history in automations,
  // but old routine clients only understand scheduled and manual runs.
  if (run.trigger === "event") return;
  return {
    ...run,
    trigger: run.trigger,
    routineId: run.automationId,
    // Older UIs have no labels for queued/cancelled. Keep the original enum
    // on this compatibility surface; automations expose the full run state.
    status:
      run.status === "queued"
        ? "running"
        : run.status === "cancelled"
          ? "skipped"
          : run.status,
    error:
      run.status === "queued"
        ? "Waiting for the active run to finish."
        : run.error,
  };
}
