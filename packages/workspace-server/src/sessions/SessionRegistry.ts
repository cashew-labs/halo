import { contentText } from "@earendil-works/pi-ai";
import * as errore from "errore";
import {
  BACKGROUND_CONTEXT,
  type Session,
  type SessionMetadata,
  type HarnessEvent,
} from "@earendil-works/pi-agent-core";
import { laneState } from "@earendil-works/pi-agent-core/harness/session";
import { Stream } from "@get-halo/shared/Stream";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import {
  chatPromptTitle,
  type HaloMessage,
  type SessionSummary,
  type SessionSummariesUpdate,
} from "@get-halo/client";
import {
  HaloAgentSession,
  CreateAgentSessionError,
  type HaloAgentSessionOptions,
} from "../agent/HaloAgentSession.js";
import type {
  SessionRepoApi,
  SessionStatus,
} from "../storage/SessionRepoApi.js";

export class SessionNotFoundError extends errore.createTaggedError({
  name: "SessionNotFoundError",
  message: "Session '$sessionId' does not exist.",
}) {}

export class ListAgentSessionsError extends errore.createTaggedError({
  name: "ListAgentSessionsError",
  message: "Failed to list agent sessions",
}) {}

export class OpenAgentSessionError extends errore.createTaggedError({
  name: "OpenAgentSessionError",
  message: "Failed to open agent session '$sessionId'",
}) {}

export class SessionNotOpenError extends errore.createTaggedError({
  name: "SessionNotOpenError",
  message: "Agent session '$sessionId' is not open.",
}) {}

class SessionRegistryClosedError extends errore.createTaggedError({
  name: "SessionRegistryClosedError",
  message: "The server is shutting down.",
}) {}

type SessionRegistryOptions = HaloAgentSessionOptions & {
  repo: SessionRepoApi;
};

type PiSessionSummary = Omit<SessionSummary, "isUnread" | "markedDone">;

export class SessionRegistry {
  private closing = false;
  private readonly closed = new AbortController();
  // Serializes snapshots and updates so reconnect cannot miss a transition.
  private readonly summaryQueue = new SerialQueue();
  private readonly summaries = new Map<string, SessionSummary>();
  private readonly summaryChanges = new Stream<SessionSummariesUpdate>();
  private readonly summarySubscriptions = new Map<string, () => void>();
  private readonly statusBySession = new Map<string, SessionStatus>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly sessions = new Map<string, HaloAgentSession>();
  private readonly stored = new Map<string, Promise<Session | Error>>();
  private readonly opening = new Map<
    string,
    Promise<Error | HaloAgentSession>
  >();
  private readonly repo: SessionRepoApi;
  private readonly environment: HaloAgentSessionOptions["environment"];
  private readonly llmApi: HaloAgentSessionOptions["llmApi"];
  private readonly traces: HaloAgentSessionOptions["traces"];
  private readonly model: HaloAgentSessionOptions["model"];
  private readonly filesystem: HaloAgentSessionOptions["filesystem"];
  private readonly layout: HaloAgentSessionOptions["layout"];
  private readonly toolRuntime: HaloAgentSessionOptions["toolRuntime"];

  constructor(ctx: SessionRegistryOptions) {
    const {
      repo,
      environment,
      llmApi,
      traces,
      model,
      filesystem,
      layout,
      toolRuntime,
    } = ctx;
    this.repo = repo;
    this.environment = environment;
    this.llmApi = llmApi;
    this.traces = traces;
    this.model = model;
    this.filesystem = filesystem;
    this.layout = layout;
    this.toolRuntime = toolRuntime;
  }

  async list() {
    return await this.track(
      async () =>
        await this.summaryQueue.run(async () => await this.listSessions()),
    );
  }

  async *watchSummaries(
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SessionSummariesUpdate> {
    const abortSignal =
      signal === undefined
        ? this.closed.signal
        : AbortSignal.any([signal, this.closed.signal]);
    const initial = await this.track(
      async () =>
        await this.summaryQueue.run(async () => {
          const sessions = await this.listSessions();
          if (sessions instanceof Error) return sessions;
          // Subscribe in the same queue turn as the snapshot; subsequent updates are buffered.
          return {
            sessions,
            updates: this.summaryChanges.consume({ abortSignal }),
          };
        }),
    );
    if (initial instanceof Error) throw initial;
    using updates = initial.updates;
    if (abortSignal.aborted) return;
    yield { type: "snapshot", sessions: initial.sessions };
    yield* updates;
  }

  async create() {
    return await this.track(async () => await this.createSession());
  }

  async open(sessionId: string) {
    return await this.track(async () => await this.openSession(sessionId));
  }

  async close(sessionId: string) {
    return await this.track(async () => await this.closeSession(sessionId));
  }

  private async track<T>(operation: () => Promise<T>) {
    if (this.closing) return new SessionRegistryClosedError();
    const pending = operation();
    this.pending.add(pending);
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => this.pending.delete(pending));
    return await pending;
  }

  private async listSessions() {
    const metadata = await this.repo
      .list(undefined, BACKGROUND_CONTEXT)
      .catch((cause) => new ListAgentSessionsError({ cause }));
    if (metadata instanceof Error) return metadata;
    const statuses = await this.repo.listStatuses();
    if (statuses instanceof Error) return statuses;
    this.statusBySession.clear();
    for (const [sessionId, status] of statuses)
      this.statusBySession.set(sessionId, status);
    const summaries: SessionSummary[] = [];
    for (const item of metadata) {
      const status = statuses.get(item.id);
      if (status === undefined)
        return new SessionNotFoundError({ sessionId: item.id });
      const cached = this.summaries.get(item.id);
      if (cached !== undefined) {
        const current = applySessionStatus(cached, status);
        this.summaries.set(item.id, current);
        summaries.push(current);
        continue;
      }
      const stored = await this.openStored(item);
      if (stored instanceof Error) return stored;
      const summary = await readSessionSummary(stored, this.layout.root).catch(
        (cause) => new ListAgentSessionsError({ cause }),
      );
      if (summary instanceof Error) return summary;
      // Unfinished operations in storage are recovered only when a session opens.
      const current = applySessionStatus(
        {
          ...summary,
          isRunning: this.sessions.has(item.id) && summary.isRunning,
        },
        status,
      );
      this.summaries.set(item.id, current);
      summaries.push(current);
    }
    return summaries.toSorted((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  private async createSession() {
    const stored = await this.repo
      .create({}, BACKGROUND_CONTEXT)
      .catch((cause) => new CreateAgentSessionError({ cause }));
    if (stored instanceof Error) return stored;
    this.statusBySession.set(stored.metadata.id, defaultSessionStatus());
    this.stored.set(stored.metadata.id, Promise.resolve(stored));
    return await this.openSession(stored.metadata.id);
  }

  private async openSession(sessionId: string) {
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return live;
    const pending = this.opening.get(sessionId);
    if (pending !== undefined) return await pending;

    const opening = this.openAndRegister(sessionId);
    this.opening.set(sessionId, opening);
    const session = await opening;
    this.opening.delete(sessionId);
    return session;
  }

  private async closeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return new SessionNotOpenError({ sessionId });
    const closed = await session.close();
    this.sessions.delete(sessionId);
    await this.summaryQueue.run(() => {
      const summary = this.summaries.get(sessionId);
      if (summary !== undefined) this.publish({ ...summary, isRunning: false });
    });
    this.summarySubscriptions.get(sessionId)?.();
    this.summarySubscriptions.delete(sessionId);
    this.stored.delete(sessionId);
    if (closed instanceof Error) return closed;
  }

  async shutdown() {
    this.closing = true;
    this.closed.abort();
    for (const unsubscribe of this.summarySubscriptions.values()) unsubscribe();
    this.summarySubscriptions.clear();
    await Promise.all(this.pending);

    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const closed = await Promise.all(
      sessions.map(async (session) => await session.close()),
    );
    const sessionError = closed.find((result) => result instanceof Error);
    this.stored.clear();
    this.statusBySession.clear();
    if (sessionError instanceof Error) return sessionError;
  }

  private async openAndRegister(sessionId: string) {
    const existing = this.stored.get(sessionId);
    const stored =
      existing === undefined
        ? await this.findStored(sessionId)
        : await existing;
    if (stored instanceof Error) return stored;
    const session = await HaloAgentSession.attach(
      {
        environment: this.environment,
        llmApi: this.llmApi,
        traces: this.traces,
        model: this.model,
        filesystem: this.filesystem,
        layout: this.layout,
        toolRuntime: this.toolRuntime,
      },
      stored,
    );
    if (session instanceof Error) {
      this.stored.delete(sessionId);
      return session;
    }
    this.register(session);
    const published = await this.publishSummary(sessionId);
    if (published instanceof Error) {
      this.summarySubscriptions.get(sessionId)?.();
      this.summarySubscriptions.delete(sessionId);
      this.sessions.delete(sessionId);
      this.stored.delete(sessionId);
      this.summaries.delete(sessionId);
      const closed = await session.close();
      if (closed instanceof Error) console.warn(closed);
      return published;
    }
    return session;
  }

  private async findStored(sessionId: string) {
    const metadata = await this.repo
      .list(undefined, BACKGROUND_CONTEXT)
      .catch((cause) => new ListAgentSessionsError({ cause }));
    if (metadata instanceof Error) return metadata;
    const item = metadata.find((candidate) => candidate.id === sessionId);
    if (item === undefined) return new SessionNotFoundError({ sessionId });
    return await this.openStored(item);
  }

  private async openStored(metadata: SessionMetadata) {
    const existing = this.stored.get(metadata.id);
    if (existing !== undefined) return await existing;
    const opening = this.repo
      .open(metadata, BACKGROUND_CONTEXT)
      .catch(
        (cause) => new OpenAgentSessionError({ sessionId: metadata.id, cause }),
      );
    this.stored.set(metadata.id, opening);
    const stored = await opening;
    if (stored instanceof Error) this.stored.delete(metadata.id);
    return stored;
  }

  private register(session: HaloAgentSession) {
    this.sessions.set(session.sessionId, session);
    this.summarySubscriptions.set(
      session.sessionId,
      session.onSummaryChange(async (event) => {
        if (this.closing) return;
        const published = await this.publishSummary(session.sessionId, event);
        if (published instanceof Error) console.warn(published);
      }),
    );
  }

  private async publishSummary(sessionId: string, event?: HarnessEvent) {
    return await this.track(
      async () =>
        await this.summaryQueue.run(async () => {
          const cached = this.summaries.get(sessionId);
          if (
            cached !== undefined &&
            event !== undefined &&
            event.type !== "value_update"
          ) {
            this.publish(applySummaryEvent(cached, event));
            return;
          }
          const stored = await this.stored.get(sessionId);
          if (stored === undefined) return;
          if (stored instanceof Error) return stored;
          const status =
            this.statusBySession.get(sessionId) ??
            (await this.repo.getStatus(sessionId));
          if (status instanceof Error) return status;
          if (status === undefined)
            return new SessionNotFoundError({ sessionId });
          this.statusBySession.set(sessionId, status);
          const summary = await readSessionSummary(
            stored,
            this.layout.root,
          ).catch((cause) => new ListAgentSessionsError({ cause }));
          if (summary instanceof Error) return summary;
          this.publish(
            applySessionStatus(
              {
                ...summary,
                isRunning: this.sessions.has(sessionId) && summary.isRunning,
              },
              status,
            ),
          );
        }),
    );
  }

  private publish(session: SessionSummary) {
    this.summaries.set(session.sessionId, session);
    this.summaryChanges.append({ type: "updated", session });
  }
}

function applySummaryEvent(
  summary: SessionSummary,
  event: HarnessEvent,
): SessionSummary {
  switch (event.type) {
    case "run_start":
      return { ...summary, isRunning: true };
    case "run_end":
      return {
        ...summary,
        isRunning: false,
        latestResultId: event.runId,
        isUnread: true,
      };
    case "fault":
      return { ...summary, isRunning: false };
    case "entry_added": {
      const entry = event.entry;
      const message = entry.type === "message" ? entry.message : undefined;
      const title =
        summary.title ??
        (message?.role === "user" ? userTitle(message) : undefined);
      const latestResultId =
        !summary.isRunning && message?.role === "assistant"
          ? entry.id
          : summary.latestResultId;
      return {
        ...summary,
        title: title?.trim().length === 0 ? undefined : title,
        updatedAt: new Date(entry.timestamp).toISOString(),
        latestResultId,
        isUnread:
          latestResultId === summary.latestResultId
            ? summary.isUnread
            : latestResultId !== undefined,
      };
    }
    default:
      return summary;
  }
}

function applySessionStatus(
  summary: PiSessionSummary | SessionSummary,
  status: SessionStatus,
): SessionSummary {
  return {
    ...summary,
    markedDone: status.markedDone,
    isUnread:
      summary.latestResultId !== undefined &&
      summary.latestResultId !== status.readResultId,
  };
}

function defaultSessionStatus(): SessionStatus {
  return { markedDone: false, readResultId: undefined };
}

async function readSessionSummary(
  session: Session,
  cwd: string,
): Promise<PiSessionSummary> {
  const name = await session.getName(BACKGROUND_CONTEXT);
  const entries = await session.findEntries(
    { order: "asc" },
    BACKGROUND_CONTEXT,
  );
  const first = entries.find(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
  const firstMessage =
    first?.type === "message" && first.message.role === "user"
      ? userTitle(first.message)
      : "";
  const title = name === undefined ? firstMessage : name;
  const latest = entries.at(-1);
  const lane = await session.getValue(laneState("main"), BACKGROUND_CONTEXT);
  const lastAssistant = entries.findLast(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  return {
    sessionId: session.metadata.id,
    isRunning: lane !== undefined && lane.value.currentOperationId !== null,
    latestResultId: lane?.value.lastOperationId ?? lastAssistant?.id,
    agent: "pi" as const,
    cwd,
    title: title.trim().length === 0 ? undefined : title,
    createdAt: new Date(session.metadata.createdAt).toISOString(),
    updatedAt: new Date(
      latest === undefined ? session.metadata.createdAt : latest.timestamp,
    ).toISOString(),
  };
}

function userTitle(message: Extract<HaloMessage, { role: "user" }>) {
  if (message.attachments === undefined) return contentText(message.content);
  return chatPromptTitle({
    text: message.displayText ?? contentText(message.content),
    files: message.attachments,
  });
}
