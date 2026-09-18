import { contentText } from "@earendil-works/pi-ai";
import * as errore from "errore";
import {
  BACKGROUND_CONTEXT,
  type Session,
  type SessionRepo,
  type SessionMetadata,
} from "@earendil-works/pi-agent-core";
import { laneState } from "@earendil-works/pi-agent-core/harness/session";
import type { SessionSummary } from "@get-halo/client";
import {
  HaloAgentSession,
  CreateAgentSessionError,
  type HaloAgentSessionOptions,
} from "../agent/HaloAgentSession.js";

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
  repo: SessionRepo;
};

export class SessionRegistry {
  private closing = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly sessions = new Map<string, HaloAgentSession>();
  private readonly stored = new Map<string, Promise<Session | Error>>();
  private readonly opening = new Map<
    string,
    Promise<Error | HaloAgentSession>
  >();
  constructor(private readonly options: SessionRegistryOptions) {}

  async list() {
    return await this.track(async () => await this.listSessions());
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
    const metadata = await this.options.repo
      .list(undefined, BACKGROUND_CONTEXT)
      .catch((cause) => new ListAgentSessionsError({ cause }));
    if (metadata instanceof Error) return metadata;
    const summaries: SessionSummary[] = [];
    for (const item of metadata) {
      const stored = await this.openStored(item);
      if (stored instanceof Error) return stored;
      const summary = await readSessionSummary(
        stored,
        this.options.layout.root,
      ).catch((cause) => new ListAgentSessionsError({ cause }));
      if (summary instanceof Error) return summary;
      summaries.push({
        ...summary,
        // Stored unfinished operations are recovered only when the session opens.
        isRunning: this.sessions.has(item.id) && summary.isRunning,
      });
    }
    return summaries.toSorted((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  private async createSession() {
    const stored = await this.options.repo
      .create({}, BACKGROUND_CONTEXT)
      .catch((cause) => new CreateAgentSessionError({ cause }));
    if (stored instanceof Error) return stored;
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
    this.sessions.delete(sessionId);
    this.stored.delete(sessionId);
    return await session.close();
  }

  async shutdown() {
    this.closing = true;
    await Promise.all(this.pending);

    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const closed = await Promise.all(
      sessions.map(async (session) => await session.close()),
    );
    const sessionError = closed.find((result) => result instanceof Error);
    this.stored.clear();
    if (sessionError instanceof Error) return sessionError;
  }

  private async openAndRegister(sessionId: string) {
    const existing = this.stored.get(sessionId);
    const stored =
      existing === undefined
        ? await this.findStored(sessionId)
        : await existing;
    if (stored instanceof Error) return stored;
    const session = await HaloAgentSession.attach(this.options, stored);
    if (session instanceof Error) {
      this.stored.delete(sessionId);
      return session;
    }
    this.register(session);
    return session;
  }

  private async findStored(sessionId: string) {
    const metadata = await this.options.repo
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
    const opening = this.options.repo
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
  }
}

async function readSessionSummary(session: Session, cwd: string) {
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
      ? contentText(first.message.content)
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
