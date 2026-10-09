import * as errore from "errore";
import type { AutomationScheduleSnapshot } from "./AutomationScheduleSync.js";

class AutomationReportError extends errore.createTaggedError({
  name: "AutomationReportError",
  message: "Could not publish workspace automation schedules: $detail",
}) {}

export class ControlPlaneScheduleReporter {
  private readonly origin: string;
  private readonly token: string;

  constructor(ctx: { origin: string; token: string }) {
    this.origin = ctx.origin;
    this.token = ctx.token;
  }

  async report(snapshot: AutomationScheduleSnapshot, signal: AbortSignal) {
    const response = await fetch(
      new URL("/api/workspace-runtime/automations/schedules", this.origin),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(snapshot),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      },
    ).catch(
      (cause) => new AutomationReportError({ detail: "send snapshot", cause }),
    );
    if (response instanceof Error) return response;
    const closed = await response.body?.cancel().catch(
      (cause) => new AutomationReportError({ detail: "close response", cause }), // coverage-exempt: Rename-only response cleanup error; HTTP cancellation normally resolves.
    );
    if (closed instanceof Error) return closed;
    if (!response.ok)
      return new AutomationReportError({ detail: `HTTP ${response.status}` });
  }
}
