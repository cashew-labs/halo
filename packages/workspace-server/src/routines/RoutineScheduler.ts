import type { Logger } from "@get-halo/logger";
import type { RoutineRunner } from "./RoutineRunner.js";
import type { RoutineService } from "./RoutineService.js";

// setTimeout fires immediately for delays of 2^31 ms or more; longer waits re-arm.
const maxTimerDelayMs = 2 ** 31 - 1;
const retryDelayMs = 60_000;

export class RoutineScheduler {
  // One timer for the earliest next run, re-armed whenever routines change.
  private timer: NodeJS.Timeout | undefined;
  // Due routines being claimed; re-arming waits so a due time is not fired twice.
  private firing: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;
  private stopped = false;
  private readonly routines: RoutineService;
  private readonly runner: Pick<RoutineRunner, "start">;
  private readonly logger: Logger;

  constructor(ctx: {
    routines: RoutineService;
    runner: Pick<RoutineRunner, "start">;
    logger: Logger;
  }) {
    const { routines, runner, logger } = ctx;
    this.routines = routines;
    this.runner = runner;
    this.logger = logger;
  }

  // Interrupts runs left by a previous process, skips missed occurrences, and arms the timer.
  async start() {
    const recovered = await this.routines.recover();
    if (recovered instanceof Error) return recovered;
    if (this.stopped) return;
    this.unsubscribe = this.routines.subscribe(() => this.arm());
    this.arm();
  }

  // Stops scheduling new runs. The runner owns runs that already started.
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    await this.firing;
  }

  // A routine still due since `firedAt` failed to start; it waits before retrying.
  private arm(firedAt?: number) {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || this.firing !== undefined) return;
    const nextRunAt = Math.min(
      ...this.routines
        .list()
        .flatMap((routine) =>
          routine.enabled && routine.nextRunAt !== undefined
            ? [Date.parse(routine.nextRunAt)]
            : [],
        ),
    );
    if (nextRunAt === Infinity) return;
    const delay =
      firedAt !== undefined && nextRunAt <= firedAt
        ? retryDelayMs
        : Math.min(Math.max(0, nextRunAt - Date.now()), maxTimerDelayMs);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const firingAt = Date.now();
      this.firing = this.fire(firingAt).then(() => {
        this.firing = undefined;
        this.arm(firingAt);
      });
    }, delay);
  }

  private async fire(now: number) {
    const due = this.routines
      .list()
      .filter(
        (routine) =>
          routine.enabled &&
          routine.nextRunAt !== undefined &&
          Date.parse(routine.nextRunAt) <= now,
      );
    await Promise.all(
      due.map(async (routine) => {
        const started = await this.runner.start({
          routineId: routine.id,
          trigger: "schedule",
        });
        if (started instanceof Error)
          this.logger.warn({
            event: "routine-start-failed",
            routineId: routine.id,
            error: started,
          });
      }),
    );
  }
}
