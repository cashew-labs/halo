import * as errore from "errore";
import type { RoutineScheduleSnapshot } from "./RoutineSync.js";

class RoutineReportError extends errore.createTaggedError({
  name: "RoutineReportError",
  message: "Could not publish workspace routines: $detail",
}) {}

export class ControlPlaneRoutineReporter {
  private readonly origin: string;
  private readonly token: string;

  constructor(ctx: { origin: string; token: string }) {
    this.origin = ctx.origin;
    this.token = ctx.token;
  }

  async report(snapshot: RoutineScheduleSnapshot, signal: AbortSignal) {
    const response = await fetch(
      new URL("/api/workspace-runtime/routines", this.origin),
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
      (cause) => new RoutineReportError({ detail: "send snapshot", cause }),
    );
    if (response instanceof Error) return response;
    const closed = await response.body
      ?.cancel()
      .catch(
        (cause) => new RoutineReportError({ detail: "close response", cause }),
      );
    if (closed instanceof Error) return closed;
    if (!response.ok)
      return new RoutineReportError({ detail: `HTTP ${response.status}` });
  }
}
