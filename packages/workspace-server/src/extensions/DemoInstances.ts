import crypto from "node:crypto";
import * as errore from "errore";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import type { AppSandbox } from "./AppSandbox.js";

export class DemoBusyError extends errore.createTaggedError({
  name: "DemoBusyError",
  message: "This demo is full; try again in a few minutes",
}) {}

type Instance = {
  stop(): Promise<void | Error>;
  isRunning(): boolean;
  origin: string;
  hostToken: string;
  toolToken: string;
  lastUsed: number;
};

/**
 * A template demo runs one sandboxed backend per visitor, each starting from
 * the installed sample data. Visitors never share state. When the VM is full,
 * only an instance idle for `idleMs` is stopped and its data discarded, so a
 * burst of new visitors cannot wipe demos that are in use.
 */
export class DemoInstances {
  private readonly instances = new Map<string, Instance>();
  private readonly actionQueue = new SerialQueue();
  private readonly sandbox: AppSandbox;
  private readonly extensionId: string;
  private readonly brokerPort: number;
  private readonly syncAccess: "read-only" | "shared" | "actions";
  private readonly limit: number;
  private readonly idleMs: number;
  // Instances a previous server process left running are unknown to this
  // one, so the first connection reclaims them before counting capacity.
  private reclaimed = false;

  constructor(ctx: {
    sandbox: AppSandbox;
    extensionId: string;
    brokerPort: number;
    syncAccess: "read-only" | "shared" | "actions";
    limit?: number;
    idleMs?: number;
  }) {
    this.sandbox = ctx.sandbox;
    this.extensionId = ctx.extensionId;
    this.brokerPort = ctx.brokerPort;
    this.syncAccess = ctx.syncAccess;
    this.limit = ctx.limit ?? 3;
    this.idleMs = ctx.idleMs ?? 10 * 60_000;
  }

  async connect(viewerId: string) {
    const key = crypto
      .createHash("sha256")
      .update(viewerId)
      .digest("hex")
      .slice(0, 12);
    // A running instance answers without waiting for another visitor's start.
    const running = this.instances.get(key);
    if (this.reclaimed && running?.isRunning()) {
      running.lastUsed = Date.now();
      return running;
    }
    return await this.actionQueue.run(async () => {
      if (!this.reclaimed) {
        const reset = await this.sandbox.resetInstances(this.extensionId);
        if (reset instanceof Error) return reset;
        this.reclaimed = true;
      }
      const existing = this.instances.get(key);
      if (existing?.isRunning()) {
        existing.lastUsed = Date.now();
        return existing;
      }
      if (existing !== undefined) {
        this.instances.delete(key);
        const stopped = await existing.stop();
        if (stopped instanceof Error) console.warn(stopped);
      }
      while (this.instances.size >= this.limit) {
        const [oldest] = [...this.instances].toSorted(
          ([, a], [, b]) =>
            Number(a.isRunning()) - Number(b.isRunning()) ||
            a.lastUsed - b.lastUsed,
        );
        if (
          oldest![1].isRunning() &&
          Date.now() - oldest![1].lastUsed < this.idleMs
        )
          return new DemoBusyError();
        this.instances.delete(oldest![0]);
        const stopped = await oldest![1].stop();
        if (stopped instanceof Error) console.warn(stopped);
      }
      const toolToken = crypto.randomUUID();
      const hostToken = crypto.randomUUID();
      const started = await this.sandbox.start({
        extensionId: this.extensionId,
        instance: key,
        brokerPort: this.brokerPort,
        toolToken,
        hostToken,
        syncAccess: this.syncAccess,
      });
      if (started instanceof Error) return started;
      const instance = {
        stop: started.stop,
        isRunning: started.isRunning,
        origin: new URL(started.url).origin,
        hostToken,
        toolToken,
        lastUsed: Date.now(),
      };
      this.instances.set(key, instance);
      return instance;
    });
  }

  /** Whether a tool request comes from a running demo instance. */
  identify(authorization: string) {
    return [...this.instances.values()].some(
      (instance) =>
        instance.isRunning() &&
        authorization === `Bearer ${instance.toolToken}`,
    );
  }

  async stop() {
    return await this.actionQueue.run(async () => {
      const instances = [...this.instances.values()];
      this.instances.clear();
      for (const instance of instances) {
        const stopped = await instance.stop();
        if (stopped instanceof Error) console.warn(stopped);
      }
    });
  }
}
