import * as errore from "errore";

export class WorkspaceUpdatingError extends errore.createTaggedError({
  name: "WorkspaceUpdatingError",
  message:
    "Your workspace is upgrading. Wait for it to reconnect, then try again.",
}) {}

/** Reserves an idle server before the host replaces its container. */
export class WorkspaceMaintenance {
  private operations = 0;
  private reservedUntil = 0;
  private readonly isWorkIdle: () => boolean;

  constructor(ctx: { isWorkIdle: () => boolean }) {
    this.isWorkIdle = ctx.isWorkIdle;
  }

  get busy() {
    return this.operations > 0 || !this.isWorkIdle();
  }

  get upgrading() {
    return Date.now() < this.reservedUntil;
  }

  enter() {
    if (this.upgrading) return new WorkspaceUpdatingError();
    this.operations++;
    return { [Symbol.dispose]: () => this.operations-- };
  }

  prepare(force: boolean) {
    if (!force && this.busy) return false;
    // Release admission if the host updater dies before stopping this server.
    this.reservedUntil = Date.now() + 120_000;
    return true;
  }

  cancel() {
    this.reservedUntil = 0;
  }
}
