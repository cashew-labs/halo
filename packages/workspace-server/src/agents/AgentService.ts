import crypto from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import {
  newAgentSchema,
  agentSettingsSchema,
  type AgentRecord,
  type NewAgentInput,
  type AgentSettingsInput,
  type WorkspaceSchema,
} from "@get-halo/client";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import type { DatabaseService } from "../database/DatabaseService.js";

class AgentInputError extends errore.createTaggedError({
  name: "AgentInputError",
  message: "$reason",
}) {}

class AgentStorageError extends errore.createTaggedError({
  name: "AgentStorageError",
  message: "Agent storage failed during $operation",
}) {}

type StoredAgent = WorkspaceSchema["agents"];

export class AgentService {
  // Orders creation, recovery, and settings edits against the same saved records.
  private readonly actionQueue = new SerialQueue();
  private closed = false;
  private readonly db: DatabaseService;
  private readonly createThread: (
    threadId: string,
  ) => Promise<{ threadId: string } | Error>;
  private readonly publishThread: (threadId: string) => Promise<void | Error>;
  private readonly startThread: (input: {
    threadId: string;
    requestId: string;
    prompt: string;
  }) => Promise<{ submissionId: number } | Error>;

  constructor(ctx: {
    db: DatabaseService;
    createThread: (threadId: string) => Promise<{ threadId: string } | Error>;
    publishThread: (threadId: string) => Promise<void | Error>;
    startThread: AgentService["startThread"];
  }) {
    this.db = ctx.db;
    this.createThread = ctx.createThread;
    this.publishThread = ctx.publishThread;
    this.startThread = ctx.startThread;
  }

  async new(input: NewAgentInput) {
    if (
      !Value.Check(newAgentSchema, input) ||
      input.name.trim() === "" ||
      input.requestId.trim() === ""
    )
      return new AgentInputError({
        reason:
          "Provide a name, instructions, and a nonempty creation requestId.",
      });
    return await this.actionQueue.run(async () => {
      if (this.closed)
        return new AgentInputError({ reason: "The server is shutting down." });
      const identity = crypto
        .createHash("sha256")
        .update(input.requestId)
        .digest("hex");
      const agentId = `agent-${identity}`;
      await using tx = this.db.useTransaction();
      const existing = await tx
        .get("agents", agentId)
        .catch(
          (cause) =>
            new AgentStorageError({ operation: "read creation", cause }),
        );
      if (existing instanceof Error) return existing;
      if (existing?.ready) {
        const published = await this.publishThread(existing.threadId);
        if (published instanceof Error) return published;
        return toAgentRecord(existing);
      }
      const agent: StoredAgent = existing ?? {
        id: agentId,
        threadId: `agent-thread-${identity}`,
        name: input.name.trim(),
        instructions: input.instructions,
        createdAt: Date.now(),
        ready: false,
      };
      tx.set("agents", agent);
      const saved = await this.db
        .commit(tx)
        .catch(
          (cause) =>
            new AgentStorageError({ operation: "reserve creation", cause }),
        );
      if (saved instanceof Error) return saved;
      return await this.finishCreation(agent);
    });
  }

  async list() {
    const agents = await this.db
      .query({
        collection: "agents",
        where: { ready: true },
        orderBy: { createdAt: "asc", id: "asc" },
      })
      .catch((cause) => new AgentStorageError({ operation: "list", cause }));
    if (agents instanceof Error) return agents;
    return agents.map(toAgentRecord);
  }

  async update(input: AgentSettingsInput) {
    if (!Value.Check(agentSettingsSchema, input) || input.name.trim() === "")
      return new AgentInputError({
        reason: "Provide an agent ID, a name, and instructions.",
      });
    return await this.actionQueue.run(async () => {
      if (this.closed)
        return new AgentInputError({ reason: "The server is shutting down." });
      await using tx = this.db.useTransaction();
      const agent = await tx
        .get("agents", input.agentId)
        .catch(
          (cause) =>
            new AgentStorageError({ operation: "read settings", cause }),
        );
      if (agent instanceof Error) return agent;
      if (agent === undefined || !agent.ready)
        return new AgentInputError({
          reason: "That agent does not exist. List agents to find its ID.",
        });
      const updated = {
        ...agent,
        name: input.name.trim(),
        instructions: input.instructions,
      };
      tx.set("agents", updated);
      const saved = await this.db
        .commit(tx)
        .catch(
          (cause) =>
            new AgentStorageError({ operation: "save settings", cause }),
        );
      if (saved instanceof Error) return saved;
      const published = await this.publishThread(updated.threadId);
      if (published instanceof Error) return published;
      return toAgentRecord(updated);
    });
  }

  // Includes unfinished creations so their runtimes never attach as ordinary threads.
  async findByThreadId(threadId: string) {
    const agents = await this.db
      .query({ collection: "agents", where: { threadId } })
      .catch(
        (cause) =>
          new AgentStorageError({ operation: "resolve conversation", cause }),
      );
    if (agents instanceof Error) return agents;
    return agents[0];
  }

  async recover() {
    return await this.actionQueue.run(async () => {
      const pending = await this.db
        .query({ collection: "agents", where: { ready: false } })
        .catch(
          (cause) =>
            new AgentStorageError({
              operation: "read unfinished creations",
              cause,
            }),
        );
      if (pending instanceof Error) return pending;
      for (const agent of pending) {
        const completed = await this.finishCreation(agent);
        if (completed instanceof Error) return completed;
      }
    });
  }

  async close() {
    this.closed = true;
    await this.actionQueue.run(async () => undefined);
  }

  private async finishCreation(agent: StoredAgent) {
    const thread = await this.createThread(agent.threadId);
    if (thread instanceof Error) return thread;
    const started = await this.startThread({
      threadId: agent.threadId,
      requestId: `create:${agent.id}`,
      prompt:
        "You have just been created. Introduce yourself using your name, instructions, and available memory. Offer useful ways you could help and ask what the user would like you to do. Choose your own wording and use send_user_message. If the user has already sent a task, address it instead of repeating onboarding.",
    });
    if (started instanceof Error) return started;
    await using tx = this.db.useTransaction();
    tx.set("agents", { ...agent, ready: true });
    const saved = await this.db
      .commit(tx)
      .catch(
        (cause) =>
          new AgentStorageError({ operation: "finish creation", cause }),
      );
    if (saved instanceof Error) return saved;
    const published = await this.publishThread(agent.threadId);
    if (published instanceof Error) return published;
    return toAgentRecord(agent);
  }
}

function toAgentRecord({
  id,
  threadId,
  name,
  instructions,
  createdAt,
}: AgentRecord): AgentRecord {
  return { id, threadId, name, instructions, createdAt };
}
