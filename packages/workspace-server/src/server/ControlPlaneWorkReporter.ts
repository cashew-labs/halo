import * as errore from "errore";

class WorkReportError extends errore.createTaggedError({
  name: "WorkReportError",
  message: "Could not report workspace work state: $detail",
}) {}

export class ControlPlaneWorkReporter {
  private readonly origin: string;
  private readonly token: string;

  constructor(ctx: { origin: string; token: string }) {
    this.origin = ctx.origin;
    this.token = ctx.token;
  }

  async report(idle: boolean, signal: AbortSignal) {
    const response = await fetch(
      new URL("/api/workspace-runtime/idle", this.origin),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ idle }),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      },
    ).catch((cause) => new WorkReportError({ detail: "send report", cause }));
    if (response instanceof Error) return response;
    const closed = await response.body
      ?.cancel()
      .catch(
        (cause) => new WorkReportError({ detail: "close response", cause }),
      );
    if (closed instanceof Error) return closed;
    if (!response.ok)
      return new WorkReportError({ detail: `HTTP ${response.status}` });
  }
}
