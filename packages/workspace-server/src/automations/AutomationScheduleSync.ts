import type { Logger } from "@get-halo/logger";
import type { AutomationService } from "./AutomationService.js";

// Keep the wire field during control-plane/workspace rolling upgrades.
export type AutomationScheduleSnapshot = {
  routines: Array<{ id: string; nextRunAt: string }>;
};

/** Publishes the workspace's authoritative schedule after changes and while awake. */
export class AutomationScheduleSync {
  private timer: NodeJS.Timeout | undefined;
  private reporting: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private dirty = false;
  private readonly automations: AutomationService;
  private readonly report: (
    snapshot: AutomationScheduleSnapshot,
    signal: AbortSignal,
  ) => Promise<void | Error>;
  private readonly logger: Logger;
  private readonly controller = new AbortController();

  constructor(ctx: {
    automations: AutomationService;
    report: (
      snapshot: AutomationScheduleSnapshot,
      signal: AbortSignal,
    ) => Promise<void | Error>;
    logger: Logger;
  }) {
    this.automations = ctx.automations;
    this.report = ctx.report;
    this.logger = ctx.logger;
  }

  start() {
    this.unsubscribe = this.automations.subscribe(() => this.schedule());
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
      const snapshot: AutomationScheduleSnapshot = {
        routines: this.automations
          .list()
          .flatMap((routine) =>
            routine.activation.type === "routine" &&
            routine.enabled &&
            routine.nextRunAt !== undefined
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
