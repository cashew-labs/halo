import path from "node:path";
import type { Logger } from "@get-halo/logger";
import type {
  Routine,
  RoutineAction,
  RoutineRun,
  RoutineRunTrigger,
} from "@get-halo/client";
import * as errore from "errore";
import type { HaloAgentSession } from "../agent/HaloAgentSession.js";
import { maxBashTimeoutMs, runBash } from "../agent/tools/bash/run.js";
import {
  FilesystemPathNotFoundError,
  type FilesystemService,
} from "../filesystem/FilesystemService.js";
import type { SessionRegistry } from "../sessions/SessionRegistry.js";
import type { RoutineService } from "./RoutineService.js";

class RoutineRunnerStoppedError extends errore.createTaggedError({
  name: "RoutineRunnerStoppedError",
  message: "The server is shutting down.",
  extends: errore.AbortError,
}) {}

type RunOutcome = {
  status: "completed" | "failed" | "interrupted";
  error?: string;
};

const interruptedMessage = "Halo stopped before the run finished.";
// Keeps the end of long script output, where failures usually appear.
const maxScriptOutputLength = 100_000;

export class RoutineRunner {
  // Runs in progress; stop() interrupts them and waits for their outcomes.
  private readonly active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private stopping = false;
  private readonly routines: RoutineService;
  private readonly sessions: SessionRegistry;
  private readonly filesystem: FilesystemService;
  private readonly workspaceRoot: string;
  private readonly logger: Logger;

  constructor(ctx: {
    routines: RoutineService;
    sessions: SessionRegistry;
    filesystem: FilesystemService;
    workspaceRoot: string;
    logger: Logger;
  }) {
    const { routines, sessions, filesystem, workspaceRoot, logger } = ctx;
    this.routines = routines;
    this.sessions = sessions;
    this.filesystem = filesystem;
    this.workspaceRoot = workspaceRoot;
    this.logger = logger;
  }

  // Records a run and starts it in the background. Returns the run record, or
  // undefined when a scheduled occurrence is no longer due.
  async start(input: { routineId: string; trigger: RoutineRunTrigger }) {
    if (this.stopping) return new RoutineRunnerStoppedError();
    const routine = this.routines.get(input.routineId);
    if (routine instanceof Error) return routine;
    const skipReason = await this.checkExtension(routine.extensionId);
    const run = await this.routines.beginRun({ ...input, skipReason });
    if (run instanceof Error || run === undefined) return run;
    if (run.status === "skipped") return run;
    if (this.stopping) {
      await this.finish(run, {
        status: "interrupted",
        error: interruptedMessage,
      });
      return run;
    }
    const controller = new AbortController();
    const done = this.execute({ routine, run, signal: controller.signal }).then(
      async (outcome) => {
        await this.finish(run, outcome);
        this.active.delete(run.id);
      },
    );
    this.active.set(run.id, { controller, done });
    return run;
  }

  async stop() {
    this.stopping = true;
    const active = [...this.active.values()];
    for (const run of active)
      run.controller.abort(new RoutineRunnerStoppedError());
    await Promise.all(active.map(async (run) => await run.done));
  }

  private async checkExtension(extensionId: string) {
    const stats = await this.filesystem.stat(
      path.join(this.workspaceRoot, ".halo", "extensions", extensionId),
    );
    if (stats instanceof FilesystemPathNotFoundError)
      return `Extension '${extensionId}' is not installed.`;
    if (stats instanceof Error)
      return `Could not read extension '${extensionId}': ${stats.message}`;
    if (!stats.isDirectory())
      return `Extension '${extensionId}' is not installed.`;
  }

  private async execute(input: {
    routine: Routine;
    run: RoutineRun;
    signal: AbortSignal;
  }): Promise<RunOutcome> {
    const { routine, run, signal } = input;
    const session = await this.sessions.create();
    if (session instanceof Error)
      return { status: "failed", error: session.message };
    const attached = await this.routines.attachSession({
      runId: run.id,
      sessionId: session.sessionId,
    });
    if (attached instanceof Error)
      this.logger.warn({
        event: "routine-session-link-failed",
        error: attached,
      });
    const named = await session.setName(runSessionName(routine, run));
    if (named instanceof Error)
      this.logger.warn({ event: "routine-session-name-failed", error: named });
    if (signal.aborted)
      return { status: "interrupted", error: interruptedMessage };
    if (routine.action.type === "runAgent")
      return await this.runAgent({
        session,
        prompt: routine.action.prompt,
        signal,
      });
    return await this.runScript({
      session,
      extensionId: routine.extensionId,
      action: routine.action,
      signal,
    });
  }

  private async runScript(input: {
    session: HaloAgentSession;
    extensionId: string;
    action: Extract<RoutineAction, { type: "runScript" }>;
    signal: AbortSignal;
  }): Promise<RunOutcome> {
    const { session, extensionId, action, signal } = input;
    const cwd = path.join(
      this.workspaceRoot,
      action.cwd ?? path.join(".halo", "extensions", extensionId),
    );
    const result = await runBash(this.workspaceRoot, {
      command: action.command,
      cwd,
      timeoutMs: maxBashTimeoutMs,
      signal,
    });
    // runBash keeps no partial output; a cancelled command shows only its status.
    const output =
      result instanceof Error
        ? signal.aborted
          ? ""
          : result.message
        : result.stdout + result.stderr;
    const appended = await session.appendMessages([
      {
        role: "bashExecution",
        command: action.command,
        output: output.slice(-maxScriptOutputLength),
        exitCode:
          result instanceof Error || result.code === null
            ? undefined
            : result.code,
        cancelled: result instanceof Error,
        truncated: output.length > maxScriptOutputLength,
        timestamp: Date.now(),
      },
    ]);
    if (appended instanceof Error)
      this.logger.warn({ event: "routine-output-failed", error: appended });
    if (signal.aborted)
      return { status: "interrupted", error: interruptedMessage };
    if (result instanceof Error)
      return { status: "failed", error: result.message };
    if (result.code !== 0)
      return {
        status: "failed",
        error:
          result.code === null
            ? "The script was terminated."
            : `The script exited with code ${result.code}.`,
      };
    return { status: "completed" };
  }

  private async runAgent(input: {
    session: HaloAgentSession;
    prompt: string;
    signal: AbortSignal;
  }): Promise<RunOutcome> {
    const { session, prompt, signal } = input;
    const abort = async () => {
      const aborted = await session.abort();
      if (aborted instanceof Error)
        this.logger.warn({ event: "routine-abort-failed", error: aborted });
    };
    signal.addEventListener("abort", abort, { once: true });
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => signal.removeEventListener("abort", abort));
    const outcome = await session.prompt({ text: prompt });
    if (outcome instanceof Error)
      return { status: "failed", error: outcome.message };
    if (outcome === undefined || outcome.status === "completed")
      return { status: "completed" };
    if (outcome.status === "aborted")
      return {
        status: "interrupted",
        error: signal.aborted ? interruptedMessage : "The run was stopped.",
      };
    if (outcome.status === "suspended")
      return { status: "failed", error: "The agent run was suspended." };
    return {
      status: "failed",
      error: outcome.error?.message ?? `The agent run was ${outcome.status}.`,
    };
  }

  private async finish(run: RoutineRun, outcome: RunOutcome) {
    const finished = await this.routines.finishRun({
      runId: run.id,
      ...outcome,
    });
    if (finished instanceof Error)
      this.logger.warn({ event: "routine-finish-failed", error: finished });
  }
}

// Names a run's session after its routine and occurrence, in the routine's time zone.
function runSessionName(routine: Routine, run: RoutineRun) {
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: routine.timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(run.scheduledFor));
  return `${routine.name} · ${time}`;
}
