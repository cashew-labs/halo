import type { Logger } from "@get-halo/logger";
import type { RoutineService } from "./RoutineService.js";

export type RoutineScheduleSnapshot = {
  routines: Array<{ id: string; nextRunAt: string }>;
};

/** Publishes the workspace's authoritative schedule after changes and while awake. */
export class RoutineSync {
  private timer: NodeJS.Timeout | undefined;
  private reporting: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private dirty = false;
  private readonly routines: RoutineService;
  private readonly report: (
    snapshot: RoutineScheduleSnapshot,
    signal: AbortSignal,
  ) => Promise<void | Error>;
  private readonly logger: Logger;
  private readonly controller = new AbortController();

  constructor(ctx: {
    routines: RoutineService;
    report: (
      snapshot: RoutineScheduleSnapshot,
      signal: AbortSignal,
    ) => Promise<void | Error>;
    logger: Logger;
  }) {
    this.routines = ctx.routines;
    this.report = ctx.report;
    this.logger = ctx.logger;
  }

  start() {
    this.unsubscribe = this.routines.subscribe(() => this.schedule());
    this.timer = setInterval(() => this.schedule(), 30_000);
    this.timer.unref();
    this.schedule();
  }

  async stop() {
    this.closed = true;
    this.controller.abort();
    clearInterval(this.timer);
    this.unsubscribe?.();
    await this.reporting;
  }

  private schedule() {
    if (this.closed) return;
    this.dirty = true;
    if (this.reporting !== undefined) return;
    this.reporting = this.flush();
  }

  private async flush() {
    while (this.dirty && !this.closed) {
      this.dirty = false;
      const snapshot: RoutineScheduleSnapshot = {
        routines: this.routines
          .list()
          .flatMap((routine) =>
            routine.enabled && routine.nextRunAt !== undefined
              ? [{ id: routine.id, nextRunAt: routine.nextRunAt }]
              : [],
          ),
      };
      const reported = await this.report(snapshot, this.controller.signal);
      if (reported instanceof Error && !this.closed)
        this.logger.warn({ event: "routine-sync-failed", error: reported });
    }
    this.reporting = undefined;
  }
}
