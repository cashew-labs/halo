import * as errore from "errore";
import { createHash } from "node:crypto";
import { Stream } from "@get-halo/shared/Stream";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import {
  isThreadUnread,
  agentUserMessage,
  type ThreadSummary,
  type ThreadSummariesUpdate,
  type ChatPrompt,
  type HaloMessage,
  type HaloConnectionState,
  type HaloConnectionEvent,
} from "@get-halo/client";
import {
  Thread,
  CreateAgentThreadError,
  ThreadStorageError,
  type ThreadOptions,
} from "../agent/Thread.js";
import { ThreadProjection } from "../agent/ThreadProjection.js";
import type {
  ThreadRepoApi,
  ThreadHandle,
  ThreadMetadata,
} from "../database/ThreadRepoApi.js";
import type {
  DatabaseService,
  WorkspaceSchema,
} from "../database/DatabaseService.js";
import type { UploadService } from "../uploads/UploadService.js";

type ThreadProductFields = Omit<WorkspaceSchema["sessionState"], "id">;

class ThreadStateError extends errore.createTaggedError({
  name: "ThreadStateError",
  message: "Thread state failed during $operation",
}) {}

export class ThreadNotFoundError extends errore.createTaggedError({
  name: "ThreadNotFoundError",
  message: "Thread '$threadId' does not exist.",
}) {}

export class ListAgentThreadsError extends errore.createTaggedError({
  name: "ListAgentThreadsError",
  message: "Failed to list agent threads",
}) {}

export class OpenAgentThreadError extends errore.createTaggedError({
  name: "OpenAgentThreadError",
  message: "Failed to open agent thread '$threadId'",
}) {}

export class ThreadNotOpenError extends errore.createTaggedError({
  name: "ThreadNotOpenError",
  message: "Agent thread '$threadId' is not open.",
}) {}

class ThreadManagerClosedError extends errore.createTaggedError({
  name: "ThreadManagerClosedError",
  message: "The server is shutting down.",
}) {}

type ThreadManagerOptions = ThreadOptions & {
  repo: ThreadRepoApi;
  db: DatabaseService;
  uploads: UploadService;
};

type PiThreadSummary = Omit<
  ThreadSummary,
  "markedDone" | "readReceiptCursorId"
>;

function messageContentText(
  content: Extract<HaloMessage, { role: "user" | "assistant" }>["content"],
) {
  return Array.isArray(content)
    ? content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
    : content;
}

export class ThreadManager {
  private readonly idleChanges = new Stream<boolean>();
  readonly idle = this.idleChanges.project(false, (_previous, idle) => idle);
  private readonly idleSubscriptions = new Map<string, () => void>();
  private closing = false;
  // Recovery opens threads paused until interrupted routines have been aborted.
  private started = false;
  private readonly closed = new AbortController();
  // Serializes snapshots and updates so reconnect cannot miss a transition.
  private readonly summaryQueue = new SerialQueue();
  private readonly creationQueue = new SerialQueue();
  private readonly summaries = new Map<string, ThreadSummary>();
  private readonly summaryChanges = new Stream<
    ThreadSummariesUpdate | ThreadStateError
  >();
  private readonly summarySubscriptions = new Map<string, () => void>();
  private stateSubscription: { destroy(): void } | undefined;
  private readonly lifecycleSubscriptions = new Map<string, () => void>();
  private readonly lifecycleQueues = new Map<string, SerialQueue>();
  private readonly closeFailures = new Map<string, Error>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly threads = new Map<string, Thread>();
  private readonly stored = new Map<string, Promise<ThreadHandle | Error>>();
  private readonly repo: ThreadRepoApi;
  private readonly db: DatabaseService;
  private readonly environment: ThreadOptions["environment"];
  private readonly llmApi: ThreadOptions["llmApi"];
  private readonly filesystem: ThreadOptions["filesystem"];
  private readonly layout: ThreadOptions["layout"];
  private readonly toolRuntime: ThreadOptions["toolRuntime"];
  private readonly memory: ThreadOptions["memory"];
  private readonly agents: ThreadOptions["agents"];
  private readonly uploads: UploadService;

  constructor(ctx: ThreadManagerOptions) {
    const { repo, environment, llmApi, filesystem, layout, toolRuntime } = ctx;
    this.repo = repo;
    this.db = ctx.db;
    this.environment = environment;
    this.llmApi = llmApi;
    this.filesystem = filesystem;
    this.layout = layout;
    this.toolRuntime = toolRuntime;
    this.uploads = ctx.uploads;
    this.memory = ctx.memory;
    this.agents = ctx.agents;
  }

  async list() {
    return await this.track(
      async () =>
        await this.summaryQueue.run(async () => await this.listThreads()),
    );
  }

  async start() {
    const subscription = await this.db
      .subscribe(
        { collection: "sessionState" },
        () => {
          if (this.closing) return;
          // Do not await this queue from a commit: the committing command owns it.
          void this.track(async () => {
            const refreshed = await this.summaryQueue.run(async () => {
              // Read current state here instead of applying a stale callback snapshot.
              const fields = await this.listProductFields();
              if (fields instanceof Error) return fields;
              for (const summary of this.summaries.values()) {
                const current = applyProductFields({
                  summary,
                  fields: fields.get(summary.sessionId),
                });
                if (
                  current.markedDone !== summary.markedDone ||
                  current.readReceiptCursorId !== summary.readReceiptCursorId
                )
                  this.publish(current);
              }
            });
            if (refreshed instanceof Error)
              this.summaryChanges.append(refreshed);
          }).catch((cause) => {
            const error = new ThreadStateError({
              operation: "publish",
              cause,
            });
            console.warn(error);
            this.summaryChanges.append(error);
          });
        },
        {
          onError: (cause) =>
            this.summaryChanges.append(
              new ThreadStateError({ operation: "watch", cause }),
            ),
        },
      )
      .catch(
        (cause) => new ThreadStateError({ operation: "subscribe", cause }),
      );
    if (subscription instanceof Error) return subscription;
    this.stateSubscription = subscription;

    const pending = await this.repo.listPendingThreadIds();
    if (pending instanceof Error) return pending;
    for (const threadId of pending) {
      const thread = await this.openThread(threadId);
      if (thread instanceof Error) return thread;
    }
    this.started = true;
    // Includes threads opened paused by routine recovery.
    for (const thread of this.threads.values()) thread.resume();
    this.publishIdle();
  }

  async *watchSummaries(
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ThreadSummariesUpdate> {
    const abortSignal =
      signal === undefined
        ? this.closed.signal
        : AbortSignal.any([signal, this.closed.signal]);
    const initial = await this.track(
      async () =>
        await this.summaryQueue.run(async () => {
          const threads = await this.listThreads();
          if (threads instanceof Error) return threads;
          // Subscribe in the same queue turn as the snapshot; subsequent updates are buffered.
          return {
            threads,
            updates: this.summaryChanges.consume({ abortSignal }),
          };
        }),
    );
    if (initial instanceof Error) throw initial;
    using updates = initial.updates;
    if (abortSignal.aborted) return;
    yield { type: "snapshot", sessions: initial.threads };
    for await (const update of updates) {
      if (update instanceof Error) throw update;
      yield update;
    }
  }

  // Only agent creation supplies threadId; public transports accept requestId alone.
  async new(input?: { requestId?: string; threadId?: string }) {
    return await this.track(
      async () =>
        await this.creationQueue.run(async () => {
          // Deterministic, filesystem-safe identity makes creation retries survive restart.
          const threadId =
            input?.threadId ??
            (input?.requestId === undefined
              ? undefined
              : `thread-${createHash("sha256").update(input.requestId).digest("hex")}`);
          if (threadId !== undefined) {
            const metadata = await this.repo
              .list()
              .catch((cause) => new ListAgentThreadsError({ cause }));
            if (metadata instanceof Error) return metadata;
            if (metadata.some((item) => item.id === threadId)) {
              const opened = await this.openThread(threadId);
              if (opened instanceof Error) return opened;
              return { threadId };
            }
          }
          const thread = await this.createThread(threadId);
          if (thread instanceof Error) return thread;
          return { threadId: thread.threadId };
        }),
    );
  }

  private async withThread<T>(
    threadId: string,
    operation: (thread: Thread) => Promise<T> | T,
  ) {
    return await this.track(async () => {
      const acquired = await this.acquire(threadId);
      if (acquired instanceof Error) return acquired;
      using cleanup = new errore.DisposableStack();
      cleanup.use(acquired.lease);
      return await operation(acquired.thread);
    });
  }

  private async acquire(threadId: string, options?: { observer: true }) {
    return await this.lifecycleQueue(threadId).run(async () => {
      const agent = await this.agents?.findByThreadId(threadId);
      if (agent instanceof Error) return agent;
      if (agent !== undefined && !agent.ready)
        return new ThreadNotFoundError({ threadId });
      const thread = await this.openThreadUnqueued(threadId);
      if (thread instanceof Error) return thread;
      return { thread, lease: thread.retain(options) };
    });
  }

  /** Internal creation work may be submitted before the agent becomes visible. */
  async initialize(input: {
    threadId: string;
    requestId: string;
    prompt: string;
  }) {
    return await this.track(async () => {
      const thread = await this.openThread(input.threadId);
      if (thread instanceof Error) return thread;
      using cleanup = new errore.DisposableStack();
      cleanup.use(thread.retain());
      return await thread.start(input);
    });
  }

  async prompt(input: ChatPrompt & { threadId: string }) {
    const threadContents = new Map<string, string>();
    for (const reference of input.references ?? []) {
      if (!("sessionId" in reference)) continue;
      const { sessionId: referencedThreadId } = reference;
      const snapshot = await this.snapshot(referencedThreadId, []);
      if (snapshot instanceof Error) return snapshot;
      const transcript = snapshot.entries
        .flatMap((entry) => {
          if (snapshot.agentId !== undefined) {
            const sent = agentUserMessage(entry);
            if (sent !== undefined) return [`Assistant: ${sent.text}`];
          }
          if (entry.type !== "message") return [];
          const message = entry.message;
          if (message.role === "user")
            return [
              `User: ${message.displayText ?? messageContentText(message.content)}`,
            ];
          if (message.role === "assistant" && snapshot.agentId === undefined)
            return [`Assistant: ${messageContentText(message.content)}`];
          return [];
        })
        .join("\n\n");
      threadContents.set(
        referencedThreadId,
        transcript.length > 30_000
          ? `(Earlier messages omitted)\n${transcript.slice(-30_000)}`
          : transcript,
      );
    }
    const { uploadIds = [], ...prompt } = input;
    const attachments =
      uploadIds.length === 0 ? [] : await this.uploads.claim(uploadIds);
    if (attachments instanceof Error) return attachments;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      if (attachments.length === 0) return;
      // A rejected message keeps its uploads so the client can send them again.
      const released = await this.uploads.release(attachments);
      if (released instanceof Error)
        console.warn("Could not release chat uploads:", released);
    });
    const accepted = await this.withThread(
      input.threadId,
      async (thread) =>
        await thread.prompt({ ...prompt, attachments }, threadContents),
    );
    if (accepted instanceof Error) return accepted;
    cleanup.move();
    return accepted;
  }

  async wait(
    input: { threadId: string; submissionId: number },
    signal?: AbortSignal,
  ) {
    const abortSignal =
      signal === undefined
        ? this.closed.signal
        : AbortSignal.any([signal, this.closed.signal]);
    return await this.withThread(
      input.threadId,
      async (thread) => await thread.wait(input.submissionId, abortSignal),
    );
  }

  async snapshot(threadId: string, connections: HaloConnectionState[]) {
    return await this.track(async () => {
      const agent = await this.agents?.findByThreadId(threadId);
      if (agent instanceof Error) return agent;
      if (agent !== undefined && !agent.ready)
        return new ThreadNotFoundError({ threadId });
      const thread = this.threads.get(threadId);
      if (thread !== undefined) return thread.readSnapshot(connections);
      const projection = await this.readStoredProjection(threadId);
      if (projection instanceof Error) return projection;
      return { ...projection.snapshot(), connections };
    });
  }

  async *events(
    threadId: string,
    options: {
      signal?: AbortSignal;
      readConnections: () => HaloConnectionState[];
    },
  ) {
    // Reading history must not wait for tools, skills, and the agent runtime.
    // The live watch sends a second snapshot after attaching, covering any
    // commits made while the runtime was opening.
    if (!this.threads.has(threadId)) {
      const snapshot = await this.snapshot(threadId, options.readConnections());
      if (snapshot instanceof Error) {
        yield snapshot;
        return; // coverage-exempt: threadRouter throws the yielded error and closes this generator before it resumes; the missing-thread RPC test checks the consumer-visible failure.
      }
      yield { type: "snapshot" as const, snapshot };
      if (options.signal?.aborted) return;
    }
    const acquired = await this.track(
      async () => await this.acquire(threadId, { observer: true }),
    );
    if (acquired instanceof Error) {
      yield acquired;
      return;
    }
    using cleanup = new errore.DisposableStack();
    cleanup.use(acquired.lease);
    yield* acquired.thread.watch(options);
  }

  async withdraw(input: { threadId: string; submissionId: number }) {
    return await this.withThread(
      input.threadId,
      async (thread) => await thread.withdraw(input.submissionId),
    );
  }

  async abort(threadId: string) {
    return await this.withThread(
      threadId,
      async (thread) => await thread.abort(),
    );
  }

  async setName(threadId: string, name: string) {
    return await this.withThread(
      threadId,
      async (thread) => await thread.setName(name),
    );
  }

  async appendMessages(threadId: string, messages: readonly HaloMessage[]) {
    return await this.withThread(
      threadId,
      async (thread) => await thread.appendMessages(messages),
    );
  }

  async notify(threadId: string, input: Parameters<Thread["notify"]>[0]) {
    return await this.withThread(
      threadId,
      async (thread) => await thread.notify(input),
    );
  }

  async respondToToolApproval(
    input: Parameters<Thread["respondToToolApproval"]>[0] & {
      threadId: string;
    },
  ) {
    return await this.withThread(
      input.threadId,
      async (thread) => await thread.respondToToolApproval(input),
    );
  }

  async publishConnectionEvent(threadId: string, event: HaloConnectionEvent) {
    return await this.withThread(threadId, (thread) =>
      thread.publishConnectionEvent(event),
    );
  }

  async close(threadId: string) {
    return await this.track(
      async () =>
        await this.lifecycleQueue(threadId).run(
          async () => await this.closeThread(threadId),
        ),
    );
  }

  async markRead(input: { threadId: string; observedResultId: string }) {
    const { threadId, observedResultId } = input;
    return await this.track(
      async () =>
        await this.summaryQueue.run(async () => {
          const summary = await this.getSummaryUnqueued(threadId);
          if (summary instanceof Error) return summary;
          if (
            summary.latestResultId !== observedResultId ||
            !isThreadUnread(summary)
          )
            return;
          return await this.updateProductFields({
            threadId,
            fields: { readReceiptCursorId: summary.latestResultId },
          });
        }),
    );
  }

  async markUnread(threadId: string) {
    return await this.track(
      async () =>
        await this.summaryQueue.run(async () => {
          const summary = await this.getSummaryUnqueued(threadId);
          if (summary instanceof Error) return summary;
          if (summary.latestResultId === undefined || isThreadUnread(summary))
            return;
          return await this.updateProductFields({
            threadId,
            fields: { readReceiptCursorId: undefined },
          });
        }),
    );
  }

  async markDone(threadId: string) {
    return await this.track(
      async () =>
        await this.summaryQueue.run(async () => {
          const summary = await this.getSummaryUnqueued(threadId);
          if (summary instanceof Error) return summary;
          if (summary.markedDone) return;
          return await this.updateProductFields({
            threadId,
            fields: { markedDone: true },
          });
        }),
    );
  }

  async markUndone(threadId: string) {
    return await this.track(
      async () =>
        await this.summaryQueue.run(async () => {
          const summary = await this.getSummaryUnqueued(threadId);
          if (summary instanceof Error) return summary;
          if (!summary.markedDone) return;
          return await this.updateProductFields({
            threadId,
            fields: { markedDone: false },
          });
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

  private async listThreads() {
    const metadata = await this.repo
      .list()
      .catch((cause) => new ListAgentThreadsError({ cause }));
    if (metadata instanceof Error) return metadata;
    const agents = await this.db
      .query({ collection: "agents" })
      .catch(
        (cause) =>
          new ThreadStateError({ operation: "list agent bindings", cause }),
      );
    if (agents instanceof Error) return agents;
    const unfinished = new Set(
      agents.filter((agent) => !agent.ready).map((agent) => agent.threadId),
    );
    const productFields = await this.listProductFields();
    if (productFields instanceof Error) return productFields;
    const summaries: ThreadSummary[] = [];
    for (const item of metadata) {
      if (unfinished.has(item.id)) continue;
      const fields = productFields.get(item.id);
      const cached = this.summaries.get(item.id);
      if (cached !== undefined) {
        const agent = agents.find(
          (candidate) => candidate.threadId === item.id,
        );
        const current = applyProductFields({
          summary: { ...cached, title: agent?.name ?? cached.title },
          fields,
        });
        // A list must not consume a change before the subscription publishes it.
        summaries.push(current);
        continue;
      }
      const thread = this.threads.get(item.id);
      let summary = thread?.readSummary();
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
        summary: {
          ...summary,
          title:
            agents.find((agent) => agent.threadId === item.id)?.name ??
            summary.title,
        },
        fields,
      });
      this.summaries.set(item.id, current);
      summaries.push(current);
    }
    return summaries.toSorted((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  private async getSummaryUnqueued(threadId: string) {
    const cached = this.summaries.get(threadId);
    if (cached !== undefined) {
      const fields = await this.getProductFields(threadId);
      if (fields instanceof Error) return fields;
      return applyProductFields({ summary: cached, fields });
    }
    const summaries = await this.listThreads();
    if (summaries instanceof Error) return summaries;
    return (
      summaries.find((summary) => summary.sessionId === threadId) ??
      new ThreadNotFoundError({ threadId })
    );
  }

  private async readStoredProjection(threadId: string) {
    const data = await this.repo
      .read(threadId)
      .catch((cause) => new ThreadStorageError({ threadId, cause }));
    if (data instanceof Error) return data;
    const agent = await this.agents?.findByThreadId(threadId);
    if (agent instanceof Error) return agent;
    return new ThreadProjection(data, agent);
  }

  private async listProductFields() {
    const records = await this.db
      .query({ collection: "sessionState" })
      .catch((cause) => new ThreadStateError({ operation: "list", cause }));
    if (records instanceof Error) return records;
    return new Map(records.map((record) => [record.id, record]));
  }

  private async getProductFields(threadId: string) {
    const records = await this.db
      .query({ collection: "sessionState", where: { id: threadId } })
      .catch((cause) => new ThreadStateError({ operation: "get", cause }));
    if (records instanceof Error) return records;
    return records[0];
  }

  private async updateProductFields(input: {
    threadId: string;
    fields: Partial<ThreadProductFields>;
  }) {
    await using tx = this.db.useTransaction();
    const current = await tx
      .get("sessionState", input.threadId)
      .catch(
        (cause) =>
          new ThreadStateError({ operation: "read before update", cause }),
      );
    if (current instanceof Error) return current;
    tx.set("sessionState", {
      id: input.threadId,
      markedDone: false,
      ...current,
      ...input.fields,
    });
    return await this.db
      .commit(tx)
      .catch((cause) => new ThreadStateError({ operation: "update", cause }));
  }

  private async createThread(threadId?: string) {
    const stored = await this.repo
      .create({ id: threadId })
      .catch((cause) => new CreateAgentThreadError({ cause }));
    if (stored instanceof Error) return stored;
    this.stored.set(stored.metadata.id, Promise.resolve(stored));
    return await this.openThread(stored.metadata.id);
  }

  private async openThread(threadId: string) {
    return await this.lifecycleQueue(threadId).run(
      async () => await this.openThreadUnqueued(threadId),
    );
  }

  private lifecycleQueue(threadId: string) {
    let queue = this.lifecycleQueues.get(threadId);
    if (queue === undefined) {
      queue = new SerialQueue();
      this.lifecycleQueues.set(threadId, queue);
    }
    return queue;
  }

  private async openThreadUnqueued(threadId: string) {
    const failed = this.closeFailures.get(threadId);
    if (failed !== undefined) return failed;
    const live = this.threads.get(threadId);
    if (live !== undefined) return live;
    return await this.openAndRegister(threadId);
  }

  private async closeThread(threadId: string) {
    const thread = this.threads.get(threadId);
    if (thread === undefined) return new ThreadNotOpenError({ threadId });
    const published = await this.publishSummary(threadId);
    if (published instanceof Error) return published;
    this.summarySubscriptions.get(threadId)?.();
    this.summarySubscriptions.delete(threadId);
    const closed = await thread.close();
    if (closed instanceof Error) {
      // Keep ownership until resource release is known; never admit a replacement.
      this.closeFailures.set(threadId, closed);
      return closed;
    }
    this.threads.delete(threadId);
    this.idleSubscriptions.get(threadId)?.();
    this.idleSubscriptions.delete(threadId);
    this.closeFailures.delete(threadId);
    this.publishIdle();
    this.lifecycleSubscriptions.get(threadId)?.();
    this.lifecycleSubscriptions.delete(threadId);
    await this.summaryQueue.run(() => {
      const summary = this.summaries.get(threadId);
      if (summary !== undefined) this.publish({ ...summary, isRunning: false });
    });
    this.stored.delete(threadId);
  }

  async shutdown() {
    this.closing = true;
    this.publishIdle();
    this.closed.abort();
    this.stateSubscription?.destroy();
    await Promise.all(this.pending);
    for (const unsubscribe of this.summarySubscriptions.values()) unsubscribe();
    this.summarySubscriptions.clear();
    for (const unsubscribe of this.lifecycleSubscriptions.values())
      unsubscribe();
    this.lifecycleSubscriptions.clear();
    for (const unsubscribe of this.idleSubscriptions.values()) unsubscribe();
    this.idleSubscriptions.clear();

    const threads = [...this.threads.values()];
    this.threads.clear();
    const closed = await Promise.all(
      threads.map(async (thread) => await thread.close()),
    );
    const threadError = closed.find((result) => result instanceof Error);
    this.stored.clear();
    this.lifecycleQueues.clear();
    this.closeFailures.clear();
    this.idle[Symbol.dispose]();
    if (threadError instanceof Error) return threadError;
  }

  private async openAndRegister(threadId: string) {
    const existing = this.stored.get(threadId);
    const stored =
      existing === undefined ? await this.findStored(threadId) : await existing;
    if (stored instanceof Error) return stored;
    const thread = await Thread.attach(
      {
        environment: this.environment,
        llmApi: this.llmApi,
        filesystem: this.filesystem,
        layout: this.layout,
        toolRuntime: this.toolRuntime,
        memory: this.memory,
        agents: this.agents,
      },
      stored,
    );
    if (thread instanceof Error) {
      this.stored.delete(threadId);
      return thread;
    }
    this.register(thread);
    const published = await this.publishSummary(threadId);
    if (published instanceof Error) {
      this.summarySubscriptions.get(threadId)?.();
      this.summarySubscriptions.delete(threadId);
      this.lifecycleSubscriptions.get(threadId)?.();
      this.lifecycleSubscriptions.delete(threadId);
      const closed = await thread.close();
      if (closed instanceof Error) {
        this.closeFailures.set(threadId, closed);
        console.warn(closed);
        return published;
      }
      this.threads.delete(threadId);
      this.idleSubscriptions.get(threadId)?.();
      this.idleSubscriptions.delete(threadId);
      this.publishIdle();
      this.stored.delete(threadId);
      this.summaries.delete(threadId);
      return published;
    }
    if (this.started) thread.resume();
    return thread;
  }

  private async findStored(threadId: string) {
    const metadata = await this.repo
      .list()
      .catch((cause) => new ListAgentThreadsError({ cause }));
    if (metadata instanceof Error) return metadata;
    const item = metadata.find((candidate) => candidate.id === threadId);
    if (item === undefined) return new ThreadNotFoundError({ threadId });
    return await this.openStored(item);
  }

  private async openStored(metadata: ThreadMetadata) {
    const existing = this.stored.get(metadata.id);
    if (existing !== undefined) return await existing;
    const opening = this.repo
      .open(metadata)
      .catch(
        (cause) => new OpenAgentThreadError({ threadId: metadata.id, cause }),
      );
    this.stored.set(metadata.id, opening);
    const stored = await opening;
    if (stored instanceof Error) this.stored.delete(metadata.id);
    return stored;
  }

  private register(thread: Thread) {
    this.threads.set(thread.threadId, thread);
    this.idleSubscriptions.set(
      thread.threadId,
      thread.workIdle.subscribe(() => this.publishIdle()),
    );
    this.lifecycleSubscriptions.set(
      thread.threadId,
      thread.lifecycle.subscribe(() => {
        if (this.closing) return;
        // oxlint-disable-next-line typescript/no-floating-promises -- Tracked through shutdown; returned lifecycle errors are logged below.
        this.track(
          async () =>
            await this.lifecycleQueue(thread.threadId).run(async () => {
              if (this.threads.get(thread.threadId) !== thread) return;
              const idle = await thread.canUnload();
              if (idle instanceof Error) return idle;
              if (!idle) return;
              return await this.closeThread(thread.threadId);
            }),
        ).then((result) => {
          if (result instanceof Error) console.warn(result);
        });
      }),
    );
    this.summarySubscriptions.set(
      thread.threadId,
      thread.onSummaryChange(async () => {
        if (this.closing) return;
        const published = await this.publishSummary(thread.threadId);
        if (published instanceof Error) console.warn(published);
      }),
    );
  }

  // Agent creation publishes only after its saved relationship is ready.
  async publishSummary(threadId: string) {
    return await this.track(
      async () =>
        await this.summaryQueue.run(async () => {
          const agent = await this.agents?.findByThreadId(threadId);
          if (agent instanceof Error) return agent;
          if (agent !== undefined && !agent.ready) return;
          const thread = this.threads.get(threadId);
          if (thread === undefined) return;
          const fields = await this.getProductFields(threadId);
          if (fields instanceof Error) return fields;
          const summary = await thread.readSummary();
          if (summary instanceof Error) return summary;
          this.publish(
            applyProductFields({
              summary: {
                ...summary,
                title: agent?.name ?? summary.title,
                isRunning: this.threads.has(threadId) && summary.isRunning,
              },
              fields,
            }),
          );
        }),
    );
  }

  private publish(thread: ThreadSummary) {
    this.summaries.set(thread.sessionId, thread);
    this.summaryChanges.append({ type: "updated", session: thread });
  }

  private publishIdle() {
    const idle =
      this.started &&
      !this.closing &&
      this.pending.size === 0 &&
      this.closeFailures.size === 0 &&
      [...this.threads.values()].every((thread) => thread.workIdle.latestValue);
    if (idle !== this.idle.latestValue) this.idleChanges.append(idle);
  }
}

function applyProductFields({
  summary,
  fields,
}: {
  summary: PiThreadSummary | ThreadSummary;
  fields: ThreadProductFields | undefined;
}): ThreadSummary {
  return {
    ...summary,
    markedDone: fields?.markedDone ?? false,
    readReceiptCursorId: fields?.readReceiptCursorId,
  };
}
