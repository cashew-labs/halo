import path from "node:path";
import fs from "node:fs/promises";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import { Stream } from "@get-halo/shared/Stream";
import type { Logger } from "@get-halo/logger";
import type {
  Automation,
  AutomationAction,
  AutomationRun,
  AutomationEvent,
} from "@get-halo/client";
import * as errore from "errore";
import { maxBashTimeoutMs, runBash } from "../agent/tools/bash/run.js";
import {
  FilesystemPathNotFoundError,
  type FilesystemService,
} from "../filesystem/FilesystemService.js";
import type { ThreadManager } from "../sessions/ThreadManager.js";
import type { AutomationService } from "./AutomationService.js";

class AutomationRunnerStoppedError extends errore.createTaggedError({
  name: "AutomationRunnerStoppedError",
  message: "The server is shutting down.",
  extends: errore.AbortError,
}) {}

type RunOutcome = {
  status: "completed" | "failed" | "interrupted";
  error?: string;
  sessionId?: string;
};

type AutomationThreadManager = Pick<
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

export class AutomationRunner {
  // Runs in progress; stop() interrupts them and waits for their outcomes.
  private readonly active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private stopping = false;
  private readonly actionQueue = new SerialQueue();
  private readonly idleChanges = new Stream<boolean>();
  readonly idle = this.idleChanges.project(false, (_previous, idle) => idle);
  private unsubscribe: (() => void) | undefined;
  private pumping: Promise<void> | undefined;
  private retry: NodeJS.Timeout | undefined;
  private readonly automations: AutomationService;
  private readonly sessions: AutomationThreadManager;
  private readonly filesystem: Pick<FilesystemService, "stat">;
  private readonly workspaceRoot: string;
  private readonly logger: Logger;

  constructor(ctx: {
    automations: AutomationService;
    sessions: AutomationThreadManager;
    filesystem: Pick<FilesystemService, "stat">;
    workspaceRoot: string;
    logger: Logger;
  }) {
    const { automations, sessions, filesystem, workspaceRoot, logger } = ctx;
    this.automations = automations;
    this.sessions = sessions;
    this.filesystem = filesystem;
    this.workspaceRoot = workspaceRoot;
    this.logger = logger;
  }

  // Stops agents owned by unfinished automation runs before the registry can resume all sessions.
  async recover(options?: { preserveDue?: boolean }) {
    const sessionIds = await this.automations.runningSessionIds();
    if (sessionIds instanceof Error) return sessionIds;
    for (const sessionId of sessionIds) {
      const aborted = await this.sessions.abort(sessionId);
      if (aborted instanceof Error) return aborted;
    }
    return await this.automations.recover(options);
  }

  async startWorker() {
    this.unsubscribe = this.automations.subscribe(() => this.schedule());
    await this.pump();
  }

  async start(input: { automationId: string; trigger: "manual" | "schedule" }) {
    if (this.stopping) return new AutomationRunnerStoppedError();
    const automation = this.automations.get(input.automationId);
    if (automation instanceof Error) return automation;
    const skipReason =
      automation.extensionId === undefined
        ? undefined
        : await this.checkExtension(automation.extensionId);
    const run = await this.automations.beginRun({ ...input, skipReason });
    if (run instanceof Error || run === undefined) return run;
    await this.pump();
    return await this.automations.getRun(run.id);
  }

  async acceptEvent(event: AutomationEvent) {
    if (this.stopping) return new AutomationRunnerStoppedError();
    const run = await this.automations.acceptEvent(event);
    if (run instanceof Error) return run;
    this.schedule();
    return run;
  }

  private schedule() {
    if (this.stopping) return;
    this.idleChanges.append(false);
    this.pumping = this.pump();
  }

  private async pump() {
    await this.actionQueue.run(async () => {
      clearTimeout(this.retry);
      while (!this.stopping && this.active.size < 4) {
        const claimed = await this.automations.claimNext();
        if (claimed instanceof Error) {
          this.logger.warn({
            event: "automation-claim-failed",
            error: claimed,
          });
          this.retry = setTimeout(() => this.schedule(), 1000);
          return;
        }
        if (claimed === undefined) break;
        const { automation, run, event } = claimed;
        if (this.stopping) {
          await this.finish(
            run,
            { status: "interrupted", error: interruptedMessage },
            automation.autoArchiveSession,
          );
          break;
        }
        const controller = new AbortController();
        const done = this.execute({
          automation,
          run,
          event,
          signal: controller.signal,
        }).then(async (outcome) => {
          await this.finish(run, outcome, automation.autoArchiveSession);
          this.active.delete(run.id);
          this.schedule();
        });
        this.active.set(run.id, { controller, done });
      }
      this.idleChanges.append(this.active.size === 0);
    });
  }

  async stop() {
    this.stopping = true;
    this.unsubscribe?.();
    clearTimeout(this.retry);
    await this.pumping;
    await this.actionQueue.run(() => undefined);
    const active = [...this.active.values()];
    for (const run of active)
      run.controller.abort(new AutomationRunnerStoppedError());
    await Promise.all(active.map(async (run) => await run.done));
    this.idle[Symbol.dispose]();
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
    automation: Automation;
    run: AutomationRun;
    event?: AutomationEvent;
    signal: AbortSignal;
  }): Promise<RunOutcome> {
    const { automation, run, signal, event } = input;
    const eventPath =
      event === undefined
        ? undefined
        : path.join(
            this.workspaceRoot,
            ".halo",
            "automation-events",
            `${run.id}.json`,
          );
    if (eventPath !== undefined) {
      const written = await fs
        .mkdir(path.dirname(eventPath), { recursive: true, mode: 0o700 })
        .then(
          async () =>
            await fs.writeFile(eventPath, JSON.stringify(event), {
              mode: 0o600,
            }),
        )
        .catch((cause) => new AutomationEventFileError({ cause }));
      if (written instanceof Error)
        return { status: "failed", error: written.message };
    }
    if (automation.extensionId !== undefined) {
      const missing = await this.checkExtension(automation.extensionId);
      if (missing !== undefined) return { status: "failed", error: missing };
    }
    const session = await this.sessions.new();
    if (session instanceof Error)
      return { status: "failed", error: session.message };
    const attached = await this.automations.attachSession({
      runId: run.id,
      sessionId: session.sessionId,
    });
    if (attached instanceof Error)
      this.logger.warn({
        event: "automation-session-link-failed",
        error: attached,
      });
    const named = await this.sessions.setName(
      session.sessionId,
      runSessionName(automation, run),
    );
    if (named instanceof Error)
      this.logger.warn({
        event: "automation-session-name-failed",
        error: named,
      });
    if (signal.aborted)
      return { status: "interrupted", error: interruptedMessage };
    const outcome =
      automation.action.type === "runAgent"
        ? await this.runAgent({
            session,
            prompt: automation.action.prompt,
            eventPath,
            signal,
          })
        : await this.runScript({
            session,
            extensionId: automation.extensionId,
            action: automation.action,
            eventPath,
            signal,
          });
    return { ...outcome, sessionId: session.sessionId };
  }

  private async runScript(input: {
    session: { sessionId: string };
    extensionId?: string;
    action: Extract<AutomationAction, { type: "runScript" }>;
    eventPath?: string;
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
      env: { HALO_AUTOMATION_EVENT_FILE: input.eventPath },
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
      this.logger.warn({ event: "automation-output-failed", error: appended });
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
    eventPath?: string;
    signal: AbortSignal;
  }): Promise<RunOutcome> {
    const { session, prompt, signal } = input;
    const abort = async () => {
      const aborted = await this.sessions.abort(session.sessionId);
      if (aborted instanceof Error)
        this.logger.warn({ event: "automation-abort-failed", error: aborted });
    };
    signal.addEventListener("abort", abort, { once: true });
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => signal.removeEventListener("abort", abort));
    const accepted = await this.sessions.prompt({
      sessionId: session.sessionId,
      text: prompt,
      references:
        input.eventPath === undefined
          ? undefined
          : [{ path: path.relative(this.workspaceRoot, input.eventPath) }],
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
    run: AutomationRun,
    outcome: RunOutcome,
    autoArchiveSession: boolean,
  ) {
    const finished = await this.automations.finishRun({
      runId: run.id,
      status: outcome.status,
      error: outcome.error,
    });
    if (finished instanceof Error) {
      this.logger.warn({ event: "automation-finish-failed", error: finished });
      return;
    }
    if (!autoArchiveSession || outcome.sessionId === undefined) return;
    const archived = await this.sessions.markDone(outcome.sessionId);
    if (archived instanceof Error)
      this.logger.warn({
        event: "automation-session-archive-failed",
        error: archived,
      });
  }
}

// Names a run's session after its automation and occurrence, in the automation's time zone.
function runSessionName(automation: Automation, run: AutomationRun) {
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone:
      automation.activation.type === "routine"
        ? automation.activation.schedule.timezone
        : "UTC",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(run.scheduledFor));
  return `${automation.name} · ${time}`;
}

class AutomationEventFileError extends errore.createTaggedError({
  name: "AutomationEventFileError",
  message: "Could not write automation event data",
}) {}
