import type { RoutineScheduleSnapshot } from "@get-halo/client";
import type { Logger } from "@get-halo/logger";
import type { SessionRegistry } from "../sessions/SessionRegistry.js";
import type { RoutineService } from "./RoutineService.js";

export type RoutineReporter = {
  report(snapshot: RoutineScheduleSnapshot): Promise<void | Error>;
};

export class RoutineSync {
  private timer: NodeJS.Timeout | undefined;
  private reporting: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private dirty = false;
  private readonly routines: RoutineService;
  private readonly sessions: SessionRegistry;
  private readonly reporter: RoutineReporter;
  private readonly logger: Logger;

  constructor(ctx: {
    routines: RoutineService;
    sessions: SessionRegistry;
    reporter: RoutineReporter;
    logger: Logger;
  }) {
    this.routines = ctx.routines;
    this.sessions = ctx.sessions;
    this.reporter = ctx.reporter;
    this.logger = ctx.logger;
  }

  async start() {
    const recovered = await this.routines.recover({ preserveDue: true });
    if (recovered instanceof Error) return recovered;
    this.unsubscribe = this.routines.subscribe(() => this.schedule());
    this.timer = setInterval(() => this.schedule(), 30_000);
    this.timer.unref();
    this.schedule();
  }

  async stop() {
    this.closed = true;
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
      const sessions = await this.sessions.list();
      if (sessions instanceof Error) {
        this.logger.warn({ event: "routine-sync-failed", error: sessions });
        continue;
      }
      const routines = this.routines.list();
      const snapshot: RoutineScheduleSnapshot = {
        routines: routines
          .filter((routine) => routine.enabled)
          .map((routine) => ({
            id: routine.id,
            nextRunAt: routine.nextRunAt,
          })),
        busy:
          sessions.some((session) => session.isRunning) ||
          routines.some((routine) => routine.lastRun?.status === "running"),
      };
      const reported = await this.reporter.report(snapshot);
      if (reported instanceof Error)
        this.logger.warn({ event: "routine-sync-failed", error: reported });
    }
    this.reporting = undefined;
  }
}
