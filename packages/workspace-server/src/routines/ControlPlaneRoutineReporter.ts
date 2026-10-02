import type { RoutineScheduleSnapshot } from "@get-halo/client";
import type { GoogleAuth, IdTokenClient } from "google-auth-library";
import * as errore from "errore";
import type { RoutineReporter } from "./RoutineSync.js";

class RoutineReportError extends errore.createTaggedError({
  name: "RoutineReportError",
  message: "Could not publish workspace routines to the control plane.",
}) {}

export class ControlPlaneRoutineReporter implements RoutineReporter {
  private client: IdTokenClient | undefined;
  private readonly url: string;
  private readonly auth: Pick<GoogleAuth, "getIdTokenClient">;

  constructor(ctx: {
    origin: string;
    auth: Pick<GoogleAuth, "getIdTokenClient">;
  }) {
    this.url = new URL("/api/routines/snapshot", ctx.origin).toString();
    this.auth = ctx.auth;
  }

  async report(snapshot: RoutineScheduleSnapshot) {
    const client =
      this.client ??
      (await this.auth
        .getIdTokenClient(this.url)
        .catch((cause) => new RoutineReportError({ cause })));
    if (client instanceof Error) return client;
    this.client = client;
    const response = await client
      .request({
        url: this.url,
        method: "POST",
        headers: { "content-type": "application/json" },
        data: snapshot,
        timeout: 20_000,
        retry: false,
      })
      .catch((cause) => new RoutineReportError({ cause }));
    if (response instanceof Error) return response;
  }
}
