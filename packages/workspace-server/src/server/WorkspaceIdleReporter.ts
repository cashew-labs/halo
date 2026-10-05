import * as errore from "errore";
import type { ReadonlyStream } from "@get-halo/shared/Stream";
import { Stream } from "@get-halo/shared/Stream";

/** Reports idle changes and repeats the latest snapshot while the VM is awake. */
export class WorkspaceIdleReporter {
  private readonly changes = new Stream<boolean>();
  readonly idle = this.changes.project(false, (_previous, idle) => idle);
  private readonly cleanup = new errore.DisposableStack();
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<void>>();
  private readonly report:
    | ((idle: boolean, signal: AbortSignal) => Promise<void | Error>)
    | undefined;

  constructor(ctx: {
    idle: ReadonlyStream<boolean>;
    report?: (idle: boolean, signal: AbortSignal) => Promise<void | Error>;
  }) {
    this.report = ctx.report;
    this.cleanup.defer(
      ctx.idle.subscribe((idle) => {
        if (idle === this.idle.latestValue) return;
        this.changes.append(idle);
        this.send();
      }),
    );
    const timer = setInterval(() => this.send(), 30_000);
    timer.unref();
    this.cleanup.defer(() => clearInterval(timer));
    this.send();
  }

  private send() {
    if (this.report === undefined || this.controller.signal.aborted) return;
    // Busy reports must pass an in-flight pause report so new activity can win.
    const pending = this.report(
      this.idle.latestValue,
      this.controller.signal,
    ).then((result) => {
      if (result instanceof Error && !this.controller.signal.aborted)
        console.warn(result);
    });
    this.pending.add(pending);
    // oxlint-disable-next-line typescript/no-floating-promises -- close awaits reports and transport failures are handled above.
    pending.then(() => this.pending.delete(pending));
  }

  async close() {
    this.controller.abort();
    this.cleanup.dispose();
    await Promise.all(this.pending);
    this.idle[Symbol.dispose]();
  }
}
