import { randomUUID } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { copyJson, type JsonRepresentation } from "@earendil-works/chord";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  Harness,
  createRegistry,
  defineExtension,
  section,
  type Conversation,
  type ToolRegistration,
  type EntryDraft,
  type CommitPublication,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import type { ThreadHandle, ThreadData } from "../database/ThreadRepoApi.js";
import type { LLMApi } from "../llm/LLMApi.js";
import { createPiModelRuntime } from "../llm/createPiModelRuntime.js";
import * as errore from "errore";
import {
  Stream,
  type ReadonlyStream,
  type ReadonlyProjectedStream,
} from "@get-halo/shared/Stream";
import {
  type HaloMessage as StoredMessage,
  type SessionWatchItem,
  type HaloConnectionEvent,
  type HaloConnectionState,
  type ChatPrompt,
  type SessionSnapshot,
  type SessionSummary,
  chatPromptContent,
  applySessionEvent,
  sessionToolExecutions,
  toolApprovalDecisionCustomType,
  type ToolApprovalDecision,
} from "@get-halo/client";
import {
  ToolApprovalNotFoundError,
  ToolApprovalService,
} from "./ToolApprovalService.js";
import { prepareChatAttachments } from "./chatAttachments.js";
import type { WorkspaceLayout } from "../workspace/WorkspaceService.js";
import type { FilesystemService } from "../filesystem/FilesystemService.js";
import type { ToolRuntime } from "./runtime/ToolRuntime.js";
import { createCodingTools } from "./tools/codingTools.js";
import { createExecTool } from "./tools/execTool.js";
import { limitToolOutput } from "./tools/limitToolOutput.js";
import { WorkspaceResourceLoader } from "./WorkspaceResourceLoader.js";
import type { HaloEnvironment } from "./workspacePrompt.js";
import { sessionEvents } from "./sessionEvents.js";
import {
  HaloThreadDoc,
  SessionProjection,
  type MessagePresentation,
} from "./SessionProjection.js";

export class EmptyPromptError extends errore.createTaggedError({
  name: "EmptyPromptError",
  message: "Enter a prompt first.",
}) {}
export class PromptFailedError extends errore.createTaggedError({
  name: "PromptFailedError",
  message: "$reason",
}) {}
export class AbortFailedError extends errore.createTaggedError({
  name: "AbortFailedError",
  message: "$reason",
}) {}
export class CreateAgentSessionError extends errore.createTaggedError({
  name: "CreateAgentSessionError",
  message: "Failed to create agent session",
}) {}
export class SessionStorageError extends errore.createTaggedError({
  name: "SessionStorageError",
  message: "Could not access storage for session '$sessionId'",
}) {}

type SessionNotification = {
  customType:
    | "halo.integration.connected"
    | typeof toolApprovalDecisionCustomType;
  content: string;
  details?: unknown;
};
export type ThreadOptions = {
  environment: HaloEnvironment;
  llmApi: LLMApi;
  filesystem: FilesystemService;
  layout: WorkspaceLayout;
  toolRuntime: ToolRuntime;
};

type ThreadEvent =
  | { type: "commit"; publication: CommitPublication }
  | { type: "fault"; error: string }
  | HaloConnectionEvent;

export class Thread {
  private readonly workIdleChanges = new Stream<boolean>();
  readonly workIdle = this.workIdleChanges.project(
    false,
    (_previous, idle) => idle,
  );
  private inspectingWork = false;
  private operations = 0;
  private readonly lifecycleStream = new Stream<{ type: "idle" }>();
  readonly lifecycle: ReadonlyStream<{ type: "idle" }> = this.lifecycleStream;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private idleDelayElapsed = false;
  private leases = 0;
  private activity = 0;
  private readonly eventStream = new Stream<ThreadEvent>();
  readonly events: ReadonlyStream<ThreadEvent> = this.eventStream;
  readonly snapshot: ReadonlyProjectedStream<SessionSnapshot>;
  private readonly projection: SessionProjection;
  private readonly updates = new Stream<SessionWatchItem>();
  private readonly summaryChanges = new Stream<void>();
  private readonly closed = new AbortController();
  private readonly detach: () => void;
  private readonly detachStorage: () => void;
  readonly sessionId: string;
  private readonly harness: Harness;
  private readonly conversation: Conversation;
  private readonly stored: ThreadHandle;
  private readonly filesystem: FilesystemService;
  private readonly workspaceRoot: string;
  private readonly approvals: ToolApprovalService;

  private constructor(ctx: {
    harness: Harness;
    conversation: Conversation;
    stored: ThreadHandle;
    data: ThreadData;
    filesystem: FilesystemService;
    workspaceRoot: string;
    approvals: ToolApprovalService;
  }) {
    const { harness, conversation, stored, data, filesystem, workspaceRoot } =
      ctx;
    this.harness = harness;
    this.conversation = conversation;
    this.stored = stored;
    this.sessionId = stored.metadata.id;
    this.filesystem = filesystem;
    this.workspaceRoot = workspaceRoot;
    this.approvals = ctx.approvals;
    this.projection = new SessionProjection(data);
    this.snapshot = this.events.project(
      this.projection.snapshot(),
      (previous, event) => {
        if (event.type === "fault")
          return { ...previous, activeRun: undefined, fault: event.error };
        if (event.type === "halo.connection")
          return applySessionEvent(previous, event);
        this.projection.apply(event.publication);
        return {
          ...this.projection.snapshot(),
          connections: previous.connections,
        };
      },
    );
    const publish = (event: ThreadEvent) => {
      const previous = this.snapshot.latestValue;
      const summary = this.readSummary();
      this.eventStream.append(event);
      for (const update of sessionEvents(previous, this.snapshot.latestValue))
        this.updates.append({ type: "event", event: update });
      if (JSON.stringify(summary) !== JSON.stringify(this.readSummary()))
        this.summaryChanges.append();
      this.scheduleIdle();
    };
    // Installed while the bootstrap commit still owns the mutation line.
    this.detach = harness.subscribeCommits((publication) =>
      publish({ type: "commit", publication }),
    );
    this.detachStorage = stored.fatalCommitErrors.subscribe((error) => {
      publish({ type: "fault", error: error.message });
      this.updates.append({
        type: "event",
        event: { type: "session.failed", error: error.message },
      });
      this.summaryChanges.append();
    });
  }

  static async attach(options: ThreadOptions, stored: ThreadHandle) {
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => await stored.close());
    const { layout, toolRuntime: runtime, llmApi } = options;
    const runtimeDescription = await runtime.getAgentDescription();
    if (runtimeDescription instanceof Error) return runtimeDescription;
    const resourceLoader = new WorkspaceResourceLoader({
      environment: options.environment,
      workspaceRoot: layout.root,
    });
    const reloaded = await resourceLoader.reload();
    if (reloaded instanceof Error) return reloaded;
    const approvals = new ToolApprovalService();
    cleanup.defer(() => approvals.close());
    const tools: ToolRegistration[] = [
      ...createCodingTools({
        cwd: layout.root,
        threadId: stored.metadata.id,
        modelId: llmApi.model.id,
        runtime,
      }).map((tool: AgentTool): ToolRegistration => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        replay:
          tool.name === "read" || tool.name === "viewImage" ? "safe" : "unsafe",
        execute: async (params, api, context) => {
          const result = await tool.execute(
            api.callId,
            params,
            context.abortSignal,
          );
          return {
            ...result,
            details: copyJson(result.details, {
              omitUndefinedProperties: true,
            }),
          };
        },
      })),
      createExecTool({
        runtime,
        runtimeDescription,
        modelId: llmApi.model.id,
        threadId: stored.metadata.id,
        consumeApproval: (input) => approvals.consume(input),
      }),
    ].map((tool) =>
      limitToolOutput(tool, {
        workspaceRoot: layout.root,
        sessionId: stored.metadata.id,
      }),
    );
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "halo",
        tools,
        sections: [section("halo", () => resourceLoader.getSystemPrompt())],
      }),
    );
    const harness = await Harness.open(
      stored.storage,
      {
        models: createPiModelRuntime(llmApi),
        registry,
        settings: { toolExecution: "parallel" },
        onReport: (error) => console.warn("Pi Durable", error),
      },
      BACKGROUND_CONTEXT,
    ).catch((cause) => new CreateAgentSessionError({ cause }));
    if (harness instanceof Error) return harness;
    cleanup.defer(async () => await harness.close(BACKGROUND_CONTEXT));
    const conversation = await harness
      .root(BACKGROUND_CONTEXT, {
        init: async (tx, conversationId) => {
          await tx.doc(HaloThreadDoc, conversationId);
        },
      })
      .catch((cause) => new CreateAgentSessionError({ cause }));
    if (conversation instanceof Error) return conversation;
    const configured = await conversation
      .configure(
        {
          model: { provider: llmApi.model.provider, modelId: llmApi.model.id },
          cwd: layout.root,
        },
        BACKGROUND_CONTEXT,
      )
      .catch((cause) => new CreateAgentSessionError({ cause }));
    if (configured instanceof Error) return configured;
    const session = await harness
      .commit(
        async () =>
          new Thread({
            harness,
            conversation,
            stored,
            data: await stored.read(),
            filesystem: options.filesystem,
            workspaceRoot: layout.root,
            approvals,
          }),
        BACKGROUND_CONTEXT,
      )
      .catch((cause) => new CreateAgentSessionError({ cause }));
    if (session instanceof Error) return session;
    cleanup.move();
    return session;
  }

  resume() {
    this.harness.resume();
    this.scheduleIdle();
  }

  retain(options?: { observer: true }): Disposable {
    this.leases++;
    if (options?.observer !== true) this.operations++;
    this.scheduleIdle();
    return {
      [Symbol.dispose]: () => {
        this.leases--;
        if (options?.observer !== true) this.operations--;
        this.scheduleIdle();
      },
    };
  }

  async canUnload() {
    const hasOperationsOrSubscribers = this.leases > 0;
    if (
      !this.idleDelayElapsed ||
      this.closed.signal.aborted ||
      hasOperationsOrSubscribers
    )
      return false;
    const activity = this.activity;
    const inspection = await this.harness
      .inspect(BACKGROUND_CONTEXT)
      .catch(
        (cause) =>
          new SessionStorageError({ sessionId: this.sessionId, cause }),
      );
    if (inspection instanceof Error) return inspection;
    const noActivityOccurredDuringInspection = this.activity === activity;
    return (
      !this.closed.signal.aborted &&
      noActivityOccurredDuringInspection &&
      inspection.tasks.length === 0 &&
      inspection.submissions.length === 0
    );
  }

  private scheduleIdle() {
    this.activity++;
    this.publishWorkIdle(false);
    this.inspectWorkIdle();
    this.idleDelayElapsed = false;
    clearTimeout(this.idleTimer);
    if (this.closed.signal.aborted || this.leases > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleDelayElapsed = true;
      // oxlint-disable-next-line typescript/no-floating-promises -- Timer work reports inspection errors; Pi owns inspection through close.
      this.canUnload().then((idle) => {
        if (idle instanceof Error) {
          console.warn(idle);
          return;
        }
        if (idle) this.lifecycleStream.append({ type: "idle" });
      });
    }, 5 * 60_000);
    this.idleTimer.unref();
  }

  private publishWorkIdle(idle: boolean) {
    if (idle !== this.workIdle.latestValue) this.workIdleChanges.append(idle);
  }

  private inspectWorkIdle() {
    if (this.inspectingWork || this.closed.signal.aborted) return;
    this.inspectingWork = true;
    // oxlint-disable-next-line typescript/no-floating-promises -- Inspection errors are logged; stale inspections cannot declare the thread idle.
    this.inspectWorkIdleUnqueued().then((activity) => {
      this.inspectingWork = false;
      if (activity !== this.activity) this.inspectWorkIdle();
    });
  }

  private async inspectWorkIdleUnqueued() {
    while (!this.closed.signal.aborted) {
      const activity = this.activity;
      const inspection = await this.harness
        .inspect(BACKGROUND_CONTEXT)
        .catch(
          (cause) =>
            new SessionStorageError({ sessionId: this.sessionId, cause }),
        );
      if (inspection instanceof Error) {
        console.warn(inspection);
        return this.activity;
      }
      if (this.closed.signal.aborted) return;
      if (activity !== this.activity) continue;
      this.publishWorkIdle(
        this.operations === 0 &&
          inspection.tasks.length === 0 &&
          inspection.submissions.length === 0,
      );
      return activity;
    }
  }

  onSummaryChange(listener: () => Promise<void>) {
    return this.summaryChanges.subscribe(() => {
      queueMicrotask(() => {
        // oxlint-disable-next-line typescript/no-floating-promises -- The registry tracks summary work through shutdown and reports returned errors.
        listener();
      });
    });
  }

  readSnapshot(connections: HaloConnectionState[]) {
    return { ...this.snapshot.latestValue, connections };
  }

  async *watch(options: {
    signal?: AbortSignal;
    readConnections: () => HaloConnectionState[];
  }): AsyncGenerator<SessionWatchItem> {
    const abortSignal =
      options.signal === undefined
        ? this.closed.signal
        : AbortSignal.any([options.signal, this.closed.signal]);
    using updates = this.updates.consume({ abortSignal });
    if (abortSignal.aborted) return;
    yield {
      type: "snapshot",
      snapshot: this.readSnapshot(options.readConnections()),
    };
    yield* updates;
  }

  publishConnectionEvent(event: HaloConnectionEvent) {
    this.eventStream.append(event);
    this.updates.append({ type: "event", event });
  }

  async respondToToolApproval(input: {
    approvalId: string;
    decision: ToolApprovalDecision;
  }) {
    const approval = sessionToolExecutions(this.readSnapshot([]))
      .flatMap((execution) =>
        execution.type === "exec" ? execution.approvals : [],
      )
      .find((candidate) => candidate.id === input.approvalId);
    if (approval === undefined || approval.status !== "pending")
      return new ToolApprovalNotFoundError({ approvalId: input.approvalId });
    const reserved = this.approvals.reserve(approval.id);
    if (reserved instanceof Error) return reserved;
    const content =
      input.decision === "allow"
        ? `[System] The user approved ${approval.toolPath} once. Retry that operation with the same arguments and continue their last request.`
        : `[System] The user denied ${approval.toolPath}. Do not retry that operation. Continue their last request without it.`;
    const saved = await this.conversation
      .commit(async (tx) => {
        await tx.appendEntry(this.conversation.id, {
          kind: "halo.message",
          // The separate continuation supplies model context; this entry records the decision even if that input is aborted.
          model: [],
          data: {
            message: {
              role: "custom",
              customType: toolApprovalDecisionCustomType,
              content,
              details: { approvalId: approval.id, decision: input.decision },
              display: false,
              timestamp: Date.now(),
            },
          },
        });
      }, BACKGROUND_CONTEXT)
      .catch(
        (cause) =>
          new SessionStorageError({ sessionId: this.sessionId, cause }),
      );
    if (saved instanceof Error) {
      this.approvals.release(approval.id);
      return saved;
    }
    if (input.decision === "allow") this.approvals.allow(approval);
    const response = await this.notify({
      customType: toolApprovalDecisionCustomType,
      content,
    });
    if (response instanceof Error) return response;
  }

  async appendMessages(messages: readonly StoredMessage[]) {
    return await this.conversation
      .commit(async (tx) => {
        for (const message of messages)
          await tx.appendEntry(this.conversation.id, messageDraft(message));
      }, BACKGROUND_CONTEXT)
      .catch(
        (cause) =>
          new SessionStorageError({ sessionId: this.sessionId, cause }),
      );
  }

  async setName(name: string) {
    return await this.conversation
      .commit(async (tx) => {
        (await tx.doc(HaloThreadDoc, this.conversation.id)).name = name;
      }, BACKGROUND_CONTEXT)
      .catch(
        (cause) =>
          new SessionStorageError({ sessionId: this.sessionId, cause }),
      );
  }

  async prompt(input: ChatPrompt) {
    const text = input.text.trim();
    const files = input.files ?? [];
    const references = input.references ?? [];
    if (text.length === 0 && files.length === 0 && references.length === 0)
      return new EmptyPromptError();
    const content = chatPromptContent(text, references);
    if (files.length > 0) {
      const prepared = await prepareChatAttachments({
        files,
        filesystem: this.filesystem,
        workspaceRoot: this.workspaceRoot,
      });
      if (prepared instanceof Error) return prepared;
      return await this.send({
        role: "user",
        content: [{ type: "text", text: content }, ...prepared.content],
        displayText: text,
        attachments: prepared.attachments,
        references,
        clientMessageId: input.clientMessageId,
        timestamp: Date.now(),
      });
    }
    return await this.send({
      role: "user",
      content,
      displayText: text,
      references,
      clientMessageId: input.clientMessageId,
      timestamp: Date.now(),
    });
  }

  private async send(
    message: Extract<StoredMessage, { role: "user" | "custom" }>,
  ) {
    const requestId =
      message.role === "user"
        ? (message.clientMessageId ?? randomUUID())
        : randomUUID();
    const saved = await this.conversation
      .commit(async (tx) => {
        const state = await tx.doc(HaloThreadDoc, this.conversation.id);
        const { content: _content, ...presentation } = message;
        // SAFETY: Removing undefined optional fields preserves the presentation shape and makes it valid Chord JSON.
        state.inputs[requestId] ??= copyJson(presentation, {
          omitUndefinedProperties: true,
        }) as JsonRepresentation<MessagePresentation>;
      }, BACKGROUND_CONTEXT)
      .catch(
        (cause) =>
          new PromptFailedError({ reason: "Could not save message", cause }),
      );
    if (saved instanceof Error) return saved;
    const submitted = await this.conversation
      .submit(
        {
          type: "input",
          content: message.content,
          requestId,
          whenBusy: "steer",
        },
        BACKGROUND_CONTEXT,
      )
      .catch(
        (cause) => new PromptFailedError({ reason: "Prompt failed", cause }),
      );
    if (submitted instanceof Error) return submitted;
    return { submissionId: Number(submitted.id) };
  }

  async wait(submissionId: number, signal?: AbortSignal) {
    const context = withAbortSignal(
      signal === undefined
        ? this.closed.signal
        : AbortSignal.any([signal, this.closed.signal]),
      BACKGROUND_CONTEXT,
    );
    if (!Number.isSafeInteger(submissionId) || submissionId < 1)
      return new PromptFailedError({ reason: "Invalid submission ID" });
    // SAFETY: The external ID is a positive safe integer; Pi checks its existence below.
    const submitted = await this.harness
      .submission(submissionId as SubmissionId, context)
      .catch(
        (cause) =>
          new PromptFailedError({ reason: "Could not read submission", cause }),
      );
    if (submitted instanceof Error) return submitted;
    if (submitted === undefined)
      return new PromptFailedError({ reason: "Unknown thread submission" });
    const status = await submitted
      .status(context)
      .catch(
        (cause) =>
          new PromptFailedError({ reason: "Could not read submission", cause }),
      );
    if (status instanceof Error) return status;
    if (
      status.conversationId !== this.conversation.id ||
      status.type !== "input"
    )
      return new PromptFailedError({ reason: "Unknown thread submission" });
    const settled = await submitted
      .wait(context)
      .catch(
        (cause) =>
          new PromptFailedError({ reason: "Prompt interrupted", cause }),
      );
    if (settled instanceof Error) return settled;
    return {
      status:
        settled.status === "done"
          ? ("completed" as const)
          : settled.reason === "aborted"
            ? ("aborted" as const)
            : ("failed" as const),
      error:
        settled.status === "unanswered"
          ? { message: settled.reason }
          : undefined,
    };
  }

  async abort() {
    return await this.conversation
      .abort(BACKGROUND_CONTEXT)
      .catch(
        (cause) => new AbortFailedError({ reason: "Abort failed", cause }),
      );
  }
  async notify(input: SessionNotification) {
    return await this.send({
      role: "custom",
      ...input,
      display: false,
      timestamp: Date.now(),
    });
  }

  async close() {
    this.publishWorkIdle(false);
    this.closed.abort();
    this.approvals.close();
    clearTimeout(this.idleTimer);
    const closed = await this.harness
      .close(BACKGROUND_CONTEXT)
      .catch(
        (cause) =>
          new AbortFailedError({ reason: "Session close failed", cause }),
      );
    this.detach();
    this.detachStorage();
    this.snapshot[Symbol.dispose]();
    this.workIdle[Symbol.dispose]();
    if (closed instanceof Error) return closed;
  }

  readSummary(): Omit<SessionSummary, "markedDone" | "readReceiptCursorId"> {
    return this.projection.summary({
      metadata: this.stored.metadata,
      cwd: this.workspaceRoot,
      snapshot: this.snapshot.latestValue,
    });
  }
}

function messageDraft(message: StoredMessage): EntryDraft {
  const model: Message[] =
    message.role === "user" || message.role === "assistant"
      ? [message]
      : message.role === "toolResult"
        ? [
            {
              ...message,
              details:
                message.details === undefined
                  ? undefined
                  : copyJson(message.details, {
                      omitUndefinedProperties: true,
                    }),
            },
          ]
        : message.role === "custom"
          ? [
              {
                role: "user",
                content: message.content,
                timestamp: message.timestamp,
              },
            ]
          : [];
  return {
    kind: "halo.message",
    model,
    data: copyJson({ message }, { omitUndefinedProperties: true }),
  };
}
