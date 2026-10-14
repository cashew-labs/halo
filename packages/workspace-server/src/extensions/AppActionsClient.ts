import { isDeepStrictEqual } from "node:util";
import * as errore from "errore";

class AppActionsError extends errore.createTaggedError({
  name: "AppActionsError",
  message: "App action request failed",
}) {}

type ActionResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      error: { code: string; message: string; retryable?: boolean };
    };

/** An app VM's only route to integrations: named, owner-fixed requests. */
export type AppActions = {
  invoke(ctx: {
    name: string;
    arguments: unknown;
    signal?: AbortSignal;
  }): Promise<ActionResult | Error>;
};

/** Calls the control plane with the app VM's own credential. */
export class AppActionsClient implements AppActions {
  private readonly origin: string;
  private readonly token: string;

  constructor(ctx: { origin: string; token: string }) {
    this.origin = ctx.origin;
    this.token = ctx.token;
  }

  async invoke(ctx: {
    name: string;
    arguments: unknown;
    signal?: AbortSignal;
  }) {
    // No arguments means "run the fixed request"; anything else must match it.
    const empty =
      ctx.arguments === undefined || isDeepStrictEqual(ctx.arguments, {});
    const response = await fetch(
      new URL(
        `/api/app-runtime/actions/${encodeURIComponent(ctx.name)}`,
        this.origin,
      ),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(empty ? {} : { arguments: ctx.arguments }),
        signal: ctx.signal,
      },
    ).catch((cause) => new AppActionsError({ cause })); // coverage-exempt: Network failure reaching the control plane.
    if (response instanceof Error) return response;
    // SAFETY: The control plane answers with JSON; fields are checked below.
    const body = (await response
      .json()
      .catch((cause) => new AppActionsError({ cause }))) as // coverage-exempt: The control plane answered without JSON.
      | { status?: string; result?: unknown; message?: string }
      | Error;
    if (response.status === 429)
      return {
        ok: false,
        error: {
          code: "rate_limited",
          message: "This app reached its action limit; try again later",
          retryable: true,
        },
      } satisfies ActionResult;
    if (body instanceof Error) return body;
    if (response.status === 400)
      return {
        ok: false,
        error: {
          code: "invalid_action",
          message: body.message ?? "Invalid app action",
        },
      } satisfies ActionResult;
    if (!response.ok) return new AppActionsError();
    if (body.status === "completed")
      return { ok: true, data: body.result } satisfies ActionResult;
    return {
      ok: false,
      error: {
        code: body.status ?? "failed",
        message: body.message ?? "The app action did not complete",
      },
    } satisfies ActionResult;
  }
}
