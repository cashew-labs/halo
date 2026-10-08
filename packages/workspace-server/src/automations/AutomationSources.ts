import {
  InvalidAutomationError,
  type AutomationSourceState,
} from "@get-halo/client";
import type { AutomationService } from "./AutomationService.js";
import type { AutomationSync } from "./AutomationSync.js";
import type { ControlPlaneAutomationClient } from "./ControlPlaneAutomationClient.js";

/** Synchronizes the local definition before reading its control-plane source. */
export class AutomationSources {
  private readonly automations: AutomationService;
  private readonly sync: AutomationSync | undefined;
  private readonly control:
    | Pick<ControlPlaneAutomationClient, "report" | "status">
    | undefined;
  constructor(ctx: {
    automations: AutomationService;
    sync?: AutomationSync;
    control?: Pick<ControlPlaneAutomationClient, "report" | "status">;
  }) {
    this.automations = ctx.automations;
    this.sync = ctx.sync;
    this.control = ctx.control;
  }
  async status(automationId: string) {
    const automation = this.automations.get(automationId);
    if (automation instanceof Error) return automation;
    if (automation.activation.type !== "trigger")
      return new InvalidAutomationError({
        reason: "Scheduled routines do not have an external trigger source",
      });
    if (this.control === undefined || this.sync === undefined) {
      const state: AutomationSourceState = {
        automationId,
        revision: automation.revision,
        kind: automation.activation.trigger.type,
        status: "needsAttention",
        detail: "External triggers require a control-plane connection.",
        deliveries: [],
      };
      return state;
    }
    const synced = await this.sync.synchronize();
    if (synced instanceof Error) return synced;
    return await this.control.status(automationId);
  }
}
