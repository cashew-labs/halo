import * as errore from "errore";
import type {
  AutomationGmailConnection,
  AutomationSnapshot,
  AutomationSourceState,
  AutomationWebhookAccess,
} from "@get-halo/client";

class AutomationControlPlaneError extends errore.createTaggedError({
  name: "AutomationControlPlaneError",
  message: "Automation control plane request failed: $detail",
}) {}

export class ControlPlaneAutomationClient {
  private readonly origin: string;
  private readonly token: string;
  constructor(ctx: { origin: string; token: string }) {
    this.origin = ctx.origin;
    this.token = ctx.token;
  }

  async gmailConnections() {
    const response = await this.request({
      path: "/gmail/connections",
      method: "GET",
    });
    if (response instanceof Error) return response;
    // SAFETY: The authenticated control plane returns the owner-scoped public contract.
    return await (
      response.json() as Promise<AutomationGmailConnection[]>
    ).catch(
      (cause) =>
        new AutomationControlPlaneError({
          detail: "list Gmail connections",
          cause,
        }),
    );
  }

  async report(snapshot: AutomationSnapshot, signal: AbortSignal) {
    const response = await this.request({
      path: "",
      method: "POST",
      body: JSON.stringify(snapshot),
      signal,
    });
    if (response instanceof Error) return response;
    const closed = await response.body
      ?.cancel()
      .catch(
        (cause) =>
          new AutomationControlPlaneError({ detail: "close response", cause }),
      );
    if (closed instanceof Error) return closed;
  }

  async status(automationId: string) {
    const response = await this.request({
      path: `/${encodeURIComponent(automationId)}`,
      method: "GET",
    });
    if (response instanceof Error) return response;
    // SAFETY: The authenticated control-plane endpoint returns this public contract.
    return await (response.json() as Promise<AutomationSourceState>).catch(
      (cause) =>
        new AutomationControlPlaneError({
          detail: "read source status",
          cause,
        }),
    );
  }

  async webhookAccess(input: { automationId: string; rotate?: boolean }) {
    const response = await this.request({
      path: `/${encodeURIComponent(input.automationId)}/${input.rotate === true ? "rotate" : "reveal"}`,
      method: "POST",
    });
    if (response instanceof Error) return response;
    // SAFETY: The authenticated owner-only endpoint returns this public contract.
    return await (response.json() as Promise<AutomationWebhookAccess>).catch(
      (cause) =>
        new AutomationControlPlaneError({
          detail: "read webhook credentials",
          cause,
        }),
    );
  }

  private async request(input: {
    path: string;
    method: string;
    body?: string;
    signal?: AbortSignal;
  }) {
    const response = await fetch(
      new URL(`/api/workspace-runtime/automations${input.path}`, this.origin),
      {
        method: input.method,
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: input.body,
        redirect: "error",
        signal:
          input.signal === undefined
            ? AbortSignal.timeout(10_000)
            : AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]),
      },
    ).catch(
      (cause) =>
        new AutomationControlPlaneError({ detail: "send request", cause }),
    );
    if (response instanceof Error) return response;
    if (!response.ok) {
      const closed = await response.body?.cancel().catch(
        (cause) =>
          new AutomationControlPlaneError({
            detail: "close error response",
            cause,
          }),
      );
      if (closed instanceof Error) return closed;
      return new AutomationControlPlaneError({
        detail: `HTTP ${response.status}`,
      });
    }
    return response;
  }
}
