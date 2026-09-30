import * as errore from "errore";
import { createHash } from "node:crypto";
import { Stream } from "@get-halo/shared/Stream";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import {
  isThreadUnread,
  type SessionSummary,
  type SessionSummariesUpdate,
  type ChatPrompt,
  type HaloMessage,
  type HaloConnectionState,
  type HaloConnectionEvent,
} from "@get-halo/client";
import {
  Thread,
  CreateAgentSessionError,
  SessionStorageError,
  type ThreadOptions,
} from "../agent/Thread.js";
import { SessionProjection } from "../agent/SessionProjection.js";
import type {
  ThreadProductFields,
  ThreadRepoApi,
  ThreadHandle,
  ThreadMetadata,
} from "../database/ThreadRepoApi.js";

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

class ThreadManagerClosedError extends errore.createTaggedError({
  name: "ThreadManagerClosedError",
  message: "The server is shutting down.",
}) {}

type ThreadManagerOptions = ThreadOptions & {
  repo: ThreadRepoApi;
};

type PiSessionSummary = Omit<
  SessionSummary,
  "markedDone" | "readReceiptCursorId"
>;

export class ThreadManager {
  private readonly idleChanges = new Stream<boolean>();
  readonly idle = this.idleChanges.project(false, (_previous, idle) => idle);
  private readonly idleSubscriptions = new Map<string, () => void>();
  private closing = false;
  // Recovery opens sessions paused until interrupted routines have been aborted.
  private started = false;
  private readonly closed = new AbortController();
  // Serializes snapshots and updates so reconnect cannot miss a transition.
  private readonly summaryQueue = new SerialQueue();
  private readonly creationQueue = new SerialQueue();
  private readonly summaries = new Map<string, SessionSummary>();
  private readonly summaryChanges = new Stream<SessionSummariesUpdate>();
  private readonly summarySubscriptions = new Map<string, () => void>();
  private readonly lifecycleSubscriptions = new Map<string, () => void>();
  private readonly lifecycleQueues = new Map<string, SerialQueue>();
  private readonly closeFailures = new Map<string, Error>();
  private readonly productFieldsBySession = new Map<
    string,
    ThreadProductFields
  >();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly sessions = new Map<string, Thread>();
  private readonly stored = new Map<string, Promise<ThreadHandle | Error>>();
  private readonly repo: ThreadRepoApi;
  private readonly environment: ThreadOptions["environment"];
  private readonly llmApi: ThreadOptions["llmApi"];
  private readonly filesystem: ThreadOptions["filesystem"];
  private readonly layout: ThreadOptions["layout"];
  private readonly toolRuntime: ThreadOptions["toolRuntime"];

  constructor(ctx: ThreadManagerOptions) {
    const { repo, environment, llmApi, filesystem, layout, toolRuntime } = ctx;
    this.repo = repo;
    this.environment = environment;
    this.llmApi = llmApi;
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

  async start() {
    const pending = await this.repo.listPendingThreadIds();
    if (pending instanceof Error) return pending;
    for (const sessionId of pending) {
      const session = await this.openSession(sessionId);
      if (session instanceof Error) return session;
    }
    this.started = true;
    // Includes threads opened paused by routine recovery.
    for (const session of this.sessions.values()) session.resume();
    this.publishIdle();
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

  async new(input?: { requestId?: string }) {
    return await this.track(
      async () =>
        await this.creationQueue.run(async () => {
          // Deterministic, filesystem-safe identity makes creation retries survive restart.
          const sessionId =
            input?.requestId === undefined
              ? undefined
              : `thread-${createHash("sha256").update(input.requestId).digest("hex")}`;
          if (sessionId !== undefined) {
            const metadata = await this.repo
              .list()
              .catch((cause) => new ListAgentSessionsError({ cause }));
            if (metadata instanceof Error) return metadata;
            if (metadata.some((item) => item.id === sessionId)) {
              const opened = await this.openSession(sessionId);
              if (opened instanceof Error) return opened;
              return { sessionId };
            }
          }
          const thread = await this.createSession(sessionId);
          if (thread instanceof Error) return thread;
          return { sessionId: thread.sessionId };
        }),
    );
  }

  private async withThread<T>(
    sessionId: string,
    operation: (thread: Thread) => Promise<T> | T,
  ) {
    return await this.track(async () => {
      const acquired = await this.acquire(sessionId);
      if (acquired instanceof Error) return acquired;
      using cleanup = new errore.DisposableStack();
      cleanup.use(acquired.lease);
      return await operation(acquired.thread);
    });
  }

  private async acquire(sessionId: string, options?: { observer: true }) {
    return await this.lifecycleQueue(sessionId).run(async () => {
      const thread = await this.openSessionUnqueued(sessionId);
      if (thread instanceof Error) return thread;
      return { thread, lease: thread.retain(options) };
    });
  }

  async prompt(input: ChatPrompt & { sessionId: string }) {
    return await this.withThread(
      input.sessionId,
      async (thread) => await thread.prompt(input),
    );
  }

  async wait(
    input: { sessionId: string; submissionId: number },
    signal?: AbortSignal,
  ) {
    const abortSignal =
      signal === undefined
        ? this.closed.signal
        : AbortSignal.any([signal, this.closed.signal]);
    return await this.withThread(
      input.sessionId,
      async (thread) => await thread.wait(input.submissionId, abortSignal),
    );
  }

  async snapshot(sessionId: string, connections: HaloConnectionState[]) {
    return await this.track(async () => {
      const thread = this.sessions.get(sessionId);
      if (thread !== undefined) return thread.readSnapshot(connections);
      const projection = await this.readStoredProjection(sessionId);
      if (projection instanceof Error) return projection;
      return { ...projection.snapshot(), connections };
    });
  }

  async *events(
    sessionId: string,
    options: {
      signal?: AbortSignal;
      readConnections: () => HaloConnectionState[];
    },
  ) {
    const acquired = await this.track(
      async () => await this.acquire(sessionId, { observer: true }),
    );
    if (acquired instanceof Error) {
      yield acquired;
      return;
    }
    using cleanup = new errore.DisposableStack();
    cleanup.use(acquired.lease);
    yield* acquired.thread.watch(options);
  }

  async abort(sessionId: string) {
    return await this.withThread(
      sessionId,
      async (thread) => await thread.abort(),
    );
  }

  async setName(sessionId: string, name: string) {
    return await this.withThread(
      sessionId,
      async (thread) => await thread.setName(name),
    );
  }

  async appendMessages(sessionId: string, messages: readonly HaloMessage[]) {
    return await this.withThread(
      sessionId,
      async (thread) => await thread.appendMessages(messages),
    );
  }

  async notify(sessionId: string, input: Parameters<Thread["notify"]>[0]) {
    return await this.withThread(
      sessionId,
      async (thread) => await thread.notify(input),
    );
  }

  async respondToToolApproval(
    input: Parameters<Thread["respondToToolApproval"]>[0] & {
      sessionId: string;
    },
  ) {
    return await this.withThread(
      input.sessionId,
      async (thread) => await thread.respondToToolApproval(input),
    );
  }

  async publishConnectionEvent(sessionId: string, event: HaloConnectionEvent) {
    return await this.withThread(sessionId, (thread) =>
      thread.publishConnectionEvent(event),
    );
  }

  async close(sessionId: string) {
    return await this.track(
      async () =>
        await this.lifecycleQueue(sessionId).run(
          async () => await this.closeSession(sessionId),
        ),
    );
  }

  async markRead(input: { sessionId: string; observedResultId: string }) {
    const { sessionId, observedResultId } = input;
    return await this.track(
      async () =>
        await this.summaryQueue.run(async () => {
          const summary = await this.getSummaryUnqueued(sessionId);
          if (summary instanceof Error) return summary;
          if (
            summary.latestResultId !== observedResultId ||
            !isThreadUnread(summary)
          )
            return;
          const readReceiptCursorId = summary.latestResultId;
          const saved = await this.repo.setReadReceipt({
            threadId: sessionId,
            readReceiptCursorId,
          });
          if (saved instanceof Error) return saved;
          this.productFieldsBySession.set(sessionId, {
            markedDone: summary.markedDone,
            readReceiptCursorId,
          });
          this.publish({ ...summary, readReceiptCursorId });
        }),
    );
  }

  async markUnread(sessionId: string) {
    return await this.track(
      async () =>
        await this.summaryQueue.run(async () => {
          const summary = await this.getSummaryUnqueued(sessionId);
          if (summary instanceof Error) return summary;
          if (summary.latestResultId === undefined || isThreadUnread(summary))
            return;
          const saved = await this.repo.setReadReceipt({
            threadId: sessionId,
          });
          if (saved instanceof Error) return saved;
          this.productFieldsBySession.set(sessionId, {
            markedDone: summary.markedDone,
          });
          this.publish({ ...summary, readReceiptCursorId: undefined });
        }),
    );
  }

  async markDone(sessionId: string) {
    return await this.track(
      async () =>
        await this.summaryQueue.run(async () => {
          const summary = await this.getSummaryUnqueued(sessionId);
          if (summary instanceof Error) return summary;
          if (summary.markedDone) return;
          const saved = await this.repo.setMarkedDone({
            threadId: sessionId,
            markedDone: true,
          });
          if (saved instanceof Error) return saved;
          const fields: ThreadProductFields = { markedDone: true };
          fields.readReceiptCursorId = summary.readReceiptCursorId;
          this.productFieldsBySession.set(sessionId, fields);
          this.publish({ ...summary, markedDone: true });
        }),
    );
  }

  async markUndone(sessionId: string) {
    return await this.track(
      async () =>
        await this.summaryQueue.run(async () => {
          const summary = await this.getSummaryUnqueued(sessionId);
          if (summary instanceof Error) return summary;
          if (!summary.markedDone) return;
          const saved = await this.repo.setMarkedDone({
            threadId: sessionId,
            markedDone: false,
          });
          if (saved instanceof Error) return saved;
          const fields: ThreadProductFields = { markedDone: false };
          fields.readReceiptCursorId = summary.readReceiptCursorId;
          this.productFieldsBySession.set(sessionId, fields);
          this.publish({ ...summary, markedDone: false });
        }),
    );
  }

  private async track<T>(operation: () => Promise<T>) {
    if (this.closing) return new ThreadManagerClosedError();
    const pending = operation();
    this.pending.add(pending);
    this.publishIdle();
    using cleanup = new errore.DisposableStack();
    cleanup.defer(() => {
      this.pending.delete(pending);
      this.publishIdle();
    });
    return await pending;
  }

  private async listSessions() {
    const metadata = await this.repo
      .list()
      .catch((cause) => new ListAgentSessionsError({ cause }));
    if (metadata instanceof Error) return metadata;
    const productFields = await this.repo.listProductFields();
    if (productFields instanceof Error) return productFields;
    this.productFieldsBySession.clear();
    for (const [sessionId, fields] of productFields)
      this.productFieldsBySession.set(sessionId, fields);
    const summaries: SessionSummary[] = [];
    for (const item of metadata) {
      const fields = productFields.get(item.id);
      if (fields === undefined)
        return new SessionNotFoundError({ sessionId: item.id });
      const session = this.sessions.get(item.id);
      let summary = session?.readSummary();
      if (summary === undefined) {
        const projection = await this.readStoredProjection(item.id);
        if (projection instanceof Error) return projection;
        summary = {
          ...projection.summary({
            metadata: item,
            cwd: this.layout.root,
            snapshot: projection.snapshot(),
          }),
          // Saved pending work is not executing while its runtime is closed.
          isRunning: false,
        };
      }
      const current = applyProductFields({
        summary,
        fields,
      });
      this.summaries.set(item.id, current);
      summaries.push(current);
    }
    return summaries.toSorted((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  private async getSummaryUnqueued(sessionId: string) {
    const cached = this.summaries.get(sessionId);
    if (cached !== undefined) return cached;
    const summaries = await this.listSessions();
    if (summaries instanceof Error) return summaries;
    return (
      summaries.find((summary) => summary.sessionId === sessionId) ??
      new SessionNotFoundError({ sessionId })
    );
  }

  private async readStoredProjection(sessionId: string) {
    const data = await this.repo
      .read(sessionId)
      .catch((cause) => new SessionStorageError({ sessionId, cause }));
    if (data instanceof Error) return data;
    return new SessionProjection(data);
  }

  private async getProductFieldsUnqueued(sessionId: string) {
    const cached = this.productFieldsBySession.get(sessionId);
    if (cached !== undefined) return cached;
    const fields = await this.repo.getProductFields(sessionId);
    if (fields instanceof Error) return fields;
    if (fields === undefined) return new SessionNotFoundError({ sessionId });
    this.productFieldsBySession.set(sessionId, fields);
    return fields;
  }

  private async createSession(sessionId?: string) {
    const stored = await this.repo
      .create({ id: sessionId })
      .catch((cause) => new CreateAgentSessionError({ cause }));
    if (stored instanceof Error) return stored;
    this.productFieldsBySession.set(stored.metadata.id, { markedDone: false });
    this.stored.set(stored.metadata.id, Promise.resolve(stored));
    return await this.openSession(stored.metadata.id);
  }

  private async openSession(sessionId: string) {
    return await this.lifecycleQueue(sessionId).run(
      async () => await this.openSessionUnqueued(sessionId),
    );
  }

  private lifecycleQueue(sessionId: string) {
    let queue = this.lifecycleQueues.get(sessionId);
    if (queue === undefined) {
      queue = new SerialQueue();
      this.lifecycleQueues.set(sessionId, queue);
    }
    return queue;
  }

  private async openSessionUnqueued(sessionId: string) {
    const failed = this.closeFailures.get(sessionId);
    if (failed !== undefined) return failed;
    const live = this.sessions.get(sessionId);
    if (live !== undefined) return live;
    return await this.openAndRegister(sessionId);
  }

  private async closeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return new SessionNotOpenError({ sessionId });
    const published = await this.publishSummary(sessionId);
    if (published instanceof Error) return published;
    this.summarySubscriptions.get(sessionId)?.();
    this.summarySubscriptions.delete(sessionId);
    const closed = await session.close();
    if (closed instanceof Error) {
      // Keep ownership until resource release is known; never admit a replacement.
      this.closeFailures.set(sessionId, closed);
      return closed;
    }
    this.sessions.delete(sessionId);
    this.idleSubscriptions.get(sessionId)?.();
    this.idleSubscriptions.delete(sessionId);
    this.closeFailures.delete(sessionId);
    this.publishIdle();
    this.lifecycleSubscriptions.get(sessionId)?.();
    this.lifecycleSubscriptions.delete(sessionId);
    await this.summaryQueue.run(() => {
      const summary = this.summaries.get(sessionId);
      if (summary !== undefined) this.publish({ ...summary, isRunning: false });
    });
    this.stored.delete(sessionId);
  }

  async shutdown() {
    this.closing = true;
    this.publishIdle();
    this.closed.abort();
    await Promise.all(this.pending);
    for (const unsubscribe of this.summarySubscriptions.values()) unsubscribe();
    this.summarySubscriptions.clear();
    for (const unsubscribe of this.lifecycleSubscriptions.values())
      unsubscribe();
    this.lifecycleSubscriptions.clear();
    for (const unsubscribe of this.idleSubscriptions.values()) unsubscribe();
    this.idleSubscriptions.clear();

    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const closed = await Promise.all(
      sessions.map(async (session) => await session.close()),
    );
    const sessionError = closed.find((result) => result instanceof Error);
    this.stored.clear();
    this.lifecycleQueues.clear();
    this.closeFailures.clear();
    this.productFieldsBySession.clear();
    this.idle[Symbol.dispose]();
    if (sessionError instanceof Error) return sessionError;
  }

  private async openAndRegister(sessionId: string) {
    const existing = this.stored.get(sessionId);
    const stored =
      existing === undefined
        ? await this.findStored(sessionId)
        : await existing;
    if (stored instanceof Error) return stored;
    const session = await Thread.attach(
      {
        environment: this.environment,
        llmApi: this.llmApi,
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
      this.lifecycleSubscriptions.get(sessionId)?.();
      this.lifecycleSubscriptions.delete(sessionId);
      const closed = await session.close();
      if (closed instanceof Error) {
        this.closeFailures.set(sessionId, closed);
        console.warn(closed);
        return published;
      }
      this.sessions.delete(sessionId);
      this.idleSubscriptions.get(sessionId)?.();
      this.idleSubscriptions.delete(sessionId);
      this.publishIdle();
      this.stored.delete(sessionId);
      this.summaries.delete(sessionId);
      return published;
    }
    if (this.started) session.resume();
    return session;
  }

  private async findStored(sessionId: string) {
    const metadata = await this.repo
      .list()
      .catch((cause) => new ListAgentSessionsError({ cause }));
    if (metadata instanceof Error) return metadata;
    const item = metadata.find((candidate) => candidate.id === sessionId);
    if (item === undefined) return new SessionNotFoundError({ sessionId });
    return await this.openStored(item);
  }

  private async openStored(metadata: ThreadMetadata) {
    const existing = this.stored.get(metadata.id);
    if (existing !== undefined) return await existing;
    const opening = this.repo
      .open(metadata)
      .catch(
        (cause) => new OpenAgentSessionError({ sessionId: metadata.id, cause }),
      );
    this.stored.set(metadata.id, opening);
    const stored = await opening;
    if (stored instanceof Error) this.stored.delete(metadata.id);
    return stored;
  }

  private register(session: Thread) {
    this.sessions.set(session.sessionId, session);
    this.idleSubscriptions.set(
      session.sessionId,
      session.workIdle.subscribe(() => this.publishIdle()),
    );
    this.lifecycleSubscriptions.set(
      session.sessionId,
      session.lifecycle.subscribe(() => {
        if (this.closing) return;
        // oxlint-disable-next-line typescript/no-floating-promises -- Tracked through shutdown; returned lifecycle errors are logged below.
        this.track(
          async () =>
            await this.lifecycleQueue(session.sessionId).run(async () => {
              if (this.sessions.get(session.sessionId) !== session) return;
              const idle = await session.canUnload();
              if (idle instanceof Error) return idle;
              if (!idle) return;
              return await this.closeSession(session.sessionId);
            }),
        ).then((result) => {
          if (result instanceof Error) console.warn(result);
        });
      }),
    );
    this.summarySubscriptions.set(
      session.sessionId,
      session.onSummaryChange(async () => {
        if (this.closing) return;
        const published = await this.publishSummary(session.sessionId);
        if (published instanceof Error) console.warn(published);
      }),
    );
  }

  private async publishSummary(sessionId: string) {
    return await this.track(
      async () =>
        await this.summaryQueue.run(async () => {
          const session = this.sessions.get(sessionId);
          if (session === undefined) return;
          const fields = await this.getProductFieldsUnqueued(sessionId);
          if (fields instanceof Error) return fields;
          const summary = await session.readSummary();
          if (summary instanceof Error) return summary;
          this.publish(
            applyProductFields({
              summary: {
                ...summary,
                isRunning: this.sessions.has(sessionId) && summary.isRunning,
              },
              fields,
            }),
          );
        }),
    );
  }

  private publish(session: SessionSummary) {
    this.summaries.set(session.sessionId, session);
    this.summaryChanges.append({ type: "updated", session });
  }

  private publishIdle() {
    const idle =
      this.started &&
      !this.closing &&
      this.pending.size === 0 &&
      this.closeFailures.size === 0 &&
      [...this.sessions.values()].every(
        (session) => session.workIdle.latestValue,
      );
    if (idle !== this.idle.latestValue) this.idleChanges.append(idle);
  }
}

function applyProductFields({
  summary,
  fields,
}: {
  summary: PiSessionSummary | SessionSummary;
  fields: ThreadProductFields;
}): SessionSummary {
  return { ...summary, ...fields };
}
