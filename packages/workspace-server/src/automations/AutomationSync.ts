import type { AutomationSnapshot } from "@get-halo/client";
import type { Logger } from "@get-halo/logger";
import type { AutomationService } from "./AutomationService.js";

export class AutomationSync {
  private scheduled: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private reporting: Promise<void | Error> | undefined;
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private dirty = false;
  private readonly controller = new AbortController();
  private readonly automations: AutomationService;
  private readonly report: (
    snapshot: AutomationSnapshot,
    signal: AbortSignal,
  ) => Promise<void | Error>;
  private readonly logger: Logger;

  constructor(ctx: {
    automations: AutomationService;
    report: (
      snapshot: AutomationSnapshot,
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
  async synchronize() {
    this.dirty = true;
    if (this.reporting !== undefined) return await this.reporting;
    this.reporting = this.flush();
    const result = await this.reporting;
    this.reporting = undefined;
    return result;
  }
  private schedule() {
    if (this.closed) return;
    this.scheduled = this.synchronize().then((result) => {
      if (result instanceof Error && !this.closed)
        this.logger.warn({ event: "automation-sync-failed", error: result });
    });
  }
  private async flush() {
    while (this.dirty && !this.closed) {
      this.dirty = false;
      const snapshot = await this.automations.registrationSnapshot();
      if (snapshot instanceof Error) return snapshot;
      const reported = await this.report(snapshot, this.controller.signal);
      if (reported instanceof Error) return reported;
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe?.();
    this.controller.abort();
    await this.reporting;
    await this.scheduled;
  }
}
