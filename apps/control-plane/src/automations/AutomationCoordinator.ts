import { createHaloClient } from "@get-halo/client";
import { GoogleAuth } from "google-auth-library";
import * as errore from "errore";
import type { WorkspaceService } from "../workspace/WorkspaceService.js";
import type { WorkspaceProviderConnection } from "../workspace/provider/WorkspaceProviderApi.js";
import type { AutomationStore } from "./AutomationStore.js";

class AutomationDeliveryError extends errore.createTaggedError({
  name: "AutomationDeliveryError",
  message: "Automation delivery failed during $operation",
}) {}

export class AutomationCoordinator {
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private closed = false;
  private lastPrunedAt = 0;
  private readonly store: AutomationStore;
  private readonly workspace: WorkspaceService;
  private readonly auth = new GoogleAuth();

  constructor(ctx: { store: AutomationStore; workspace: WorkspaceService }) {
    this.store = ctx.store;
    this.workspace = ctx.workspace;
  }
  start() {
    this.timer = setInterval(() => this.schedule(), 1000);
    this.timer.unref();
    this.schedule();
  }
  schedule() {
    if (this.closed || this.ticking !== undefined) return;
    this.ticking = this.tick().then(() => {
      this.ticking = undefined;
    });
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.ticking;
  }

  private async tick() {
    if (Date.now() - this.lastPrunedAt > 60 * 60 * 1000) {
      const pruned = await this.store.prune();
      if (pruned instanceof Error) {
        console.error(pruned);
        return;
      }
      this.lastPrunedAt = Date.now();
    }

    // Bound work in each turn; database leases also protect overlapping Cloud Run revisions.
    for (let index = 0; index < 20 && !this.closed; index++) {
      const claimed = await this.store.claim();
      if (claimed instanceof Error) {
        console.error(claimed);
        return;
      }
      if (claimed === undefined) return;
      const registration = await this.store.registration({
        workspaceId: claimed.workspaceId,
        automationId: claimed.event.automationId,
      });
      if (registration instanceof Error) {
        console.error(registration);
        return;
      }
      if (
        registration === undefined ||
        registration.enabled === 0 ||
        registration.revision !== claimed.event.revision
      ) {
        const cancelled = await this.store.settle({
          ...claimed,
          eventId: claimed.event.eventId,
          cancelled: true,
          error: "Automation changed before delivery.",
        });
        if (cancelled instanceof Error) console.error(cancelled);
        continue;
      }
      const result = await this.deliver(claimed);
      const saved = await this.store.settle({
        eventId: claimed.event.eventId,
        leaseToken: claimed.leaseToken,
        runId: result instanceof Error ? undefined : result,
        error: result instanceof Error ? result.message : undefined,
        retryMs: Math.min(60_000, 1000 * 2 ** Math.min(claimed.attempts, 6)),
      });
      if (saved instanceof Error) console.error(saved);
    }
  }

  private async deliver(
    claimed: NonNullable<
      Exclude<Awaited<ReturnType<AutomationStore["claim"]>>, Error>
    >,
  ) {
    const connection = await this.workspace.wakeForRoutine(claimed.workspaceId);
    if (connection instanceof Error) return connection;
    if (connection === undefined)
      return new AutomationDeliveryError({ operation: "find workspace" });
    const headers = await this.authorization(connection);
    if (headers instanceof Error) return headers;
    const client = createHaloClient({
      transport: { origin: connection.origin, path: "/rpc", headers },
    });
    const accepted = await client.automations
      .acceptEvent(claimed.event, { signal: AbortSignal.timeout(20_000) })
      .catch(
        (cause) =>
          new AutomationDeliveryError({ operation: "accept event", cause }),
      );
    if (accepted instanceof Error) return accepted;
    return accepted.id;
  }

  private async authorization(connection: WorkspaceProviderConnection) {
    if (connection.authorization.type === "headers")
      return { ...connection.authorization.value };
    if (connection.authorization.type === "bearer")
      return { authorization: connection.authorization.value };
    const client = await this.auth.getIdTokenClient(connection.origin).catch(
      (cause) =>
        new AutomationDeliveryError({
          operation: "create identity client",
          cause,
        }),
    );
    if (client instanceof Error) return client;
    const headers = await client.getRequestHeaders().catch(
      (cause) =>
        new AutomationDeliveryError({
          operation: "authorize workspace request",
          cause,
        }),
    );
    if (headers instanceof Error) return headers;
    const authorization = headers.get("authorization");
    if (authorization === null)
      return new AutomationDeliveryError({ operation: "read identity token" });
    return { authorization };
  }
}
