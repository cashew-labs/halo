import type { Api, Model } from "@earendil-works/pi-ai";
import {
  AgentHarness,
  type AgentLane,
  type AgentTool,
  type AgentMessage,
  type AgentHarnessTool,
  LaneBusy,
  NoActiveOperation,
} from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import type { Session } from "@earendil-works/pi-agent-core/harness/session";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import * as errore from "errore";
import { Stream } from "@get-halo/shared/Stream";
import {
  type HaloMessage as StoredMessage,
  type SessionWatchItem,
  type HaloConnectionEvent,
} from "@get-halo/shared/sessionState";
import type { WorkspaceLayout } from "../workspace/WorkspaceService.js";
import type { FilesystemService } from "../filesystem/FilesystemService.js";
import type { ToolRuntime } from "./runtime/ToolRuntime.js";
import { createAuthorizedCodingTools } from "./tools/codingTools.js";
import { createExecTool } from "./tools/execTool.js";
import { WorkspaceResourceLoader } from "./WorkspaceResourceLoader.js";
import { adaptPiEvent, sessionSnapshot } from "./sessionEvents.js";

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
  customType: "halo.integration.connected";
  content: string;
};

export type HaloAgentSessionOptions = {
  modelRuntime: ModelRuntime;
  model: Model<Api>;
  filesystem: FilesystemService;
  layout: WorkspaceLayout;
  toolRuntime: ToolRuntime;
};

export class HaloAgentSession {
  private readonly connectionEvents = new Stream<HaloConnectionEvent>();
  private readonly closed = new AbortController();

  private constructor(
    readonly sessionId: string,
    private readonly harness: AgentHarness,
    private readonly lane: AgentLane,
  ) {}

  static async attach(options: HaloAgentSessionOptions, stored: Session) {
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => await stored.close(BACKGROUND_CONTEXT));
    const layout = options.layout;
    const runtime = options.toolRuntime;
    const runtimeDescription = await runtime.getAgentDescription();
    if (runtimeDescription instanceof Error) return runtimeDescription;

    const resourceLoader = new WorkspaceResourceLoader(layout.root);
    const reloaded = await resourceLoader.reload();
    if (reloaded instanceof Error) return reloaded;
    const customTools: AgentHarnessTool<object | undefined>[] = [
      ...createAuthorizedCodingTools({
        cwd: layout.root,
        filesystem: options.filesystem,
        authority: runtime,
      }).map((tool: AgentTool): AgentHarnessTool<object | undefined> => ({
        ...tool,
        execute: async (
          id,
          params,
          onUpdate,
          _toolContext,
          _invocation,
          context,
        ) => await tool.execute(id, params, context.abortSignal, onUpdate),
      })),
      createExecTool({
        runtime,
        runtimeDescription,
        modelId: options.model.id,
      }),
    ];
    const created = await AgentHarness.create(
      {
        session: stored,
        models: options.modelRuntime,
        model: options.model,
        tools: customTools,
        systemPrompt: resourceLoader.getSystemPrompt(),
        resources: resourceLoader.getResources(),
      },
      BACKGROUND_CONTEXT,
    ).catch((cause) => new CreateAgentSessionError({ cause }));
    if (created instanceof Error) return created;
    cleanup.defer(async () => await created.harness.close(BACKGROUND_CONTEXT));
    // Attaching Pi restores unfinished operations without running them; Halo cancels them before accepting new work.
    for (const operation of created.open) {
      const recovering = await created.harness.lane(
        operation.lane,
        BACKGROUND_CONTEXT,
      );
      const aborted = await recovering.abort(BACKGROUND_CONTEXT);
      if (!aborted.ok)
        return new CreateAgentSessionError({ cause: aborted.error });
    }
    const lane = await created.harness.lane(
      "main",
      // oxlint-disable-next-line unicorn/no-null -- Pi uses null for an empty branch tip.
      { createAt: null },
      BACKGROUND_CONTEXT,
    );
    const session = new HaloAgentSession(
      stored.metadata.id,
      created.harness,
      lane,
    );
    cleanup.move();
    return session;
  }

  async readSnapshot() {
    const watch = await this.lane
      .watch(BACKGROUND_CONTEXT)
      .catch(
        (cause) =>
          new SessionStorageError({ sessionId: this.sessionId, cause }),
      );
    if (watch instanceof Error) return watch;
    watch.unsubscribe();
    return sessionSnapshot(watch.snapshot);
  }

  async *watch(
    signal: AbortSignal = this.closed.signal,
  ): AsyncGenerator<SessionWatchItem, void, void> {
    const abortSignal = AbortSignal.any([signal, this.closed.signal]);
    const stream = new Stream<SessionWatchItem>();
    using updates = stream.consume({ abortSignal });
    using cleanup = new errore.DisposableStack();
    cleanup.defer(
      this.connectionEvents.subscribe((event) =>
        stream.append({ type: "event", event }),
      ),
    );
    const watch = await this.lane.watch(BACKGROUND_CONTEXT);
    cleanup.defer(() => watch.unsubscribe());
    if (abortSignal.aborted) return;
    yield { type: "snapshot", snapshot: sessionSnapshot(watch.snapshot) };
    watch.start((event) => {
      const adapted = adaptPiEvent(event);
      if (adapted !== undefined)
        stream.append({ type: "event", event: adapted });
    });
    yield* updates;
  }

  publishConnectionEvent(event: HaloConnectionEvent) {
    this.connectionEvents.append(event);
  }

  async appendMessages(messages: readonly StoredMessage[]) {
    for (const message of messages) {
      const appended = await this.lane
        .appendMessage(
          message.role === "bashExecution"
            ? { ...message, exitCode: message.exitCode }
            : message,
          BACKGROUND_CONTEXT,
        )
        .catch(
          (cause) =>
            new SessionStorageError({ sessionId: this.sessionId, cause }),
        );
      if (appended instanceof Error) return appended;
    }
  }

  async setName(name: string) {
    return await this.harness.setName(name, BACKGROUND_CONTEXT).catch(
      (cause) =>
        new SessionStorageError({
          sessionId: this.sessionId,
          cause,
        }),
    );
  }

  async prompt(text: string) {
    if (text.trim().length === 0) return new EmptyPromptError();
    return await this.send({
      role: "user",
      content: text,
      timestamp: Date.now(),
    });
  }

  private async send(message: AgentMessage) {
    const prompted = await this.lane
      .prompt(message, BACKGROUND_CONTEXT)
      .catch(
        (cause) => new PromptFailedError({ reason: "Prompt failed", cause }),
      );
    if (prompted instanceof Error) return prompted;
    if (!prompted.ok) {
      if (!(prompted.error instanceof LaneBusy))
        return new PromptFailedError({
          reason: prompted.error.message,
          cause: prompted.error,
        });
      const queued = await this.lane
        .steer(message, undefined, BACKGROUND_CONTEXT)
        .catch(
          (cause) =>
            new PromptFailedError({ reason: "Could not queue message", cause }),
        );
      if (queued instanceof Error) return queued;
      if (!queued.ok)
        return new PromptFailedError({
          reason: queued.error.message,
          cause: queued.error,
        });
    }
  }

  async abort() {
    const aborted = await this.lane
      .abort(BACKGROUND_CONTEXT)
      .catch(
        (cause) => new AbortFailedError({ reason: "Abort failed", cause }),
      );
    if (aborted instanceof Error) return aborted;
    if (!aborted.ok && !(aborted.error instanceof NoActiveOperation))
      return new AbortFailedError({
        reason: aborted.error.message,
        cause: aborted.error,
      });
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
    this.closed.abort();
    const closed = await this.harness
      .close(BACKGROUND_CONTEXT)
      .catch(
        (cause) =>
          new AbortFailedError({ reason: "Session close failed", cause }),
      );
    if (closed instanceof Error) return closed;
  }
}
