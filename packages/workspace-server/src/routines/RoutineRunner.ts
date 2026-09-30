import path from "node:path";
import type { Logger } from "@get-halo/logger";
import type {
  Routine,
  RoutineAction,
  RoutineRun,
  RoutineRunTrigger,
} from "@get-halo/client";
import * as errore from "errore";
import { maxBashTimeoutMs, runBash } from "../agent/tools/bash/run.js";
import {
  FilesystemPathNotFoundError,
  type FilesystemService,
} from "../filesystem/FilesystemService.js";
import type { ThreadManager } from "../sessions/ThreadManager.js";
import type { RoutineService } from "./RoutineService.js";

class RoutineRunnerStoppedError extends errore.createTaggedError({
  name: "RoutineRunnerStoppedError",
  message: "The server is shutting down.",
  extends: errore.AbortError,
}) {}

type RunOutcome = {
  status: "completed" | "failed" | "interrupted";
  error?: string;
  sessionId?: string;
};

type RoutineThreadManager = Pick<
  ThreadManager,
  | "new"
  | "markDone"
  | "abort"
  | "setName"
  | "appendMessages"
  | "prompt"
  | "wait"
>;

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
  private readonly sessions: RoutineThreadManager;
  private readonly filesystem: Pick<FilesystemService, "stat">;
  private readonly workspaceRoot: string;
  private readonly logger: Logger;

  constructor(ctx: {
    routines: RoutineService;
    sessions: RoutineThreadManager;
    filesystem: Pick<FilesystemService, "stat">;
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

  // Stops agents owned by unfinished routine runs before the registry can resume all sessions.
  async recover() {
    const sessionIds = await this.routines.runningSessionIds();
    if (sessionIds instanceof Error) return sessionIds;
    for (const sessionId of sessionIds) {
      const aborted = await this.sessions.abort(sessionId);
      if (aborted instanceof Error) return aborted;
    }
    return await this.routines.recover();
  }

  // Records a run and starts it in the background. Returns the run record, or
  // undefined when a scheduled occurrence is no longer due.
  async start(input: { routineId: string; trigger: RoutineRunTrigger }) {
    if (this.stopping) return new RoutineRunnerStoppedError();
    const routine = await this.routines.get(input.routineId);
    if (routine instanceof Error) return routine;
    const skipReason =
      routine.extensionId === undefined
        ? undefined
        : await this.checkExtension(routine.extensionId);
    const run = await this.routines.beginRun({ ...input, skipReason });
    if (run instanceof Error || run === undefined) return run;
    if (run.status === "skipped") return run;
    if (this.stopping) {
      await this.finish(
        run,
        { status: "interrupted", error: interruptedMessage },
        routine.autoArchiveSession,
      );
      return run;
    }
    const controller = new AbortController();
    const done = this.execute({ routine, run, signal: controller.signal }).then(
      async (outcome) => {
        await this.finish(run, outcome, routine.autoArchiveSession);
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
    const session = await this.sessions.new();
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
    const named = await this.sessions.setName(
      session.sessionId,
      runSessionName(routine, run),
    );
    if (named instanceof Error)
      this.logger.warn({ event: "routine-session-name-failed", error: named });
    if (signal.aborted)
      return { status: "interrupted", error: interruptedMessage };
    const outcome =
      routine.action.type === "runAgent"
        ? await this.runAgent({
            session,
            prompt: routine.action.prompt,
            signal,
          })
        : await this.runScript({
            session,
            extensionId: routine.extensionId,
            action: routine.action,
            signal,
          });
    return { ...outcome, sessionId: session.sessionId };
  }

  private async runScript(input: {
    session: { sessionId: string };
    extensionId?: string;
    action: Extract<RoutineAction, { type: "runScript" }>;
    signal: AbortSignal;
  }): Promise<RunOutcome> {
    const { session, extensionId, action, signal } = input;
    const cwd = path.join(
      this.workspaceRoot,
      action.cwd ??
        (extensionId === undefined
          ? "."
          : path.join(".halo", "extensions", extensionId)),
    );
    const result = await runBash(this.workspaceRoot, {
      command: action.command,
      cwd,
      timeoutMs: maxBashTimeoutMs,
      signal,
      output: {
        directory: path.join(
          this.workspaceRoot,
          ".halo",
          "tool-outputs",
          session.sessionId,
        ),
        headChars: 0,
        tailChars: maxScriptOutputLength,
      },
    });
    // A cancelled command shows only its status; runBash discards partial output.
    const output =
      result instanceof Error
        ? signal.aborted
          ? ""
          : result.message
        : result.truncated
          ? `${result.tail}\n[Full output: ${result.fullOutputPath}]`
          : result.stdout + result.stderr;
    const appended = await this.sessions.appendMessages(session.sessionId, [
      {
        role: "bashExecution",
        command: action.command,
        output: output.slice(-maxScriptOutputLength),
        exitCode:
          result instanceof Error || result.code === null
            ? undefined
            : result.code,
        cancelled: result instanceof Error,
        truncated:
          output.length > maxScriptOutputLength ||
          (!(result instanceof Error) && result.truncated),
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
    session: { sessionId: string };
    prompt: string;
    signal: AbortSignal;
  }): Promise<RunOutcome> {
    const { session, prompt, signal } = input;
    const abort = async () => {
      const aborted = await this.sessions.abort(session.sessionId);
      if (aborted instanceof Error)
        this.logger.warn({ event: "routine-abort-failed", error: aborted });
    };
    signal.addEventListener("abort", abort, { once: true });
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => signal.removeEventListener("abort", abort));
    const accepted = await this.sessions.prompt({
      sessionId: session.sessionId,
      text: prompt,
    });
    if (accepted instanceof Error)
      return { status: "failed", error: accepted.message };
    // Cancellation may race admission; abort again once the durable input exists.
    if (signal.aborted) await abort();
    const outcome = await this.sessions.wait({ ...session, ...accepted });
    if (outcome instanceof Error)
      return { status: "failed", error: outcome.message };
    if (outcome.status === "completed") return { status: "completed" };
    if (outcome.status === "aborted")
      return {
        status: "interrupted",
        error: signal.aborted ? interruptedMessage : "The run was stopped.",
      };
    return {
      status: "failed",
      error: outcome.error?.message ?? `The agent run was ${outcome.status}.`,
    };
  }

  private async finish(
    run: RoutineRun,
    outcome: RunOutcome,
    autoArchiveSession: boolean,
  ) {
    const finished = await this.routines.finishRun({
      runId: run.id,
      status: outcome.status,
      error: outcome.error,
    });
    if (finished instanceof Error) {
      this.logger.warn({ event: "routine-finish-failed", error: finished });
      return;
    }
    if (!autoArchiveSession || outcome.sessionId === undefined) return;
    const archived = await this.sessions.markDone(outcome.sessionId);
    if (archived instanceof Error)
      this.logger.warn({
        event: "routine-session-archive-failed",
        error: archived,
      });
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
