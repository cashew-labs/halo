import { randomUUID } from "node:crypto";
import {
  Effect,
  IntegrationSlug,
  Owner,
  type Executor,
  type Connection,
} from "@executor-js/sdk/core";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import * as errore from "errore";
import type { DatabaseClient } from "../../storage/DatabaseClient.js";

export class GmailConnectionError extends errore.createTaggedError({
  name: "GmailConnectionError",
  message: "Gmail connection failed during $operation",
}) {}

type GmailConnectionResult = {
  accountName: string;
  identityLabel: string;
  defaultIdentityLabel?: string;
  isDefault: boolean;
  message: string;
};

export class GmailConnections {
  // Orders default changes and successful OAuth completions, not browser authorization.
  private readonly actionQueue = new SerialQueue();
  private readonly executor: Pick<Executor, "connections">;
  private readonly database: DatabaseClient;
  private readonly userId: string;

  constructor(ctx: {
    executor: Pick<Executor, "connections">;
    database: DatabaseClient;
    userId: string;
  }) {
    this.executor = ctx.executor;
    this.database = ctx.database;
    this.userId = ctx.userId;
  }

  async list() {
    const accounts = await Effect.runPromise(
      this.executor.connections.list({
        integration: IntegrationSlug.make("google_gmail"),
        owner: Owner.make("user"),
      }),
    ).catch(
      (cause) =>
        new GmailConnectionError({ operation: "list accounts", cause }),
    );
    if (accounts instanceof Error) return accounts;
    const savedDefault = await this.database.access(
      // SAFETY: this query selects the non-null text column declared by gmailDefaultsMigration.
      (db) =>
        db
          .prepare(
            "SELECT connection_name FROM halo_gmail_defaults WHERE user_id = ?",
          )
          .get(this.userId) as { connection_name: string } | undefined,
    );
    if (savedDefault instanceof Error) return savedDefault;
    const defaultName =
      savedDefault?.connection_name ??
      accounts.find((account) => account.name === "default")?.name;
    return accounts.map((account) => ({
      name: String(account.name),
      identityLabel: account.identityLabel ?? "Unverified account",
      address: String(account.address),
      isDefault: account.name === defaultName,
    }));
  }

  async setDefault(accountName: string) {
    return await this.actionQueue.run(async () => {
      const accounts = await this.list();
      if (accounts instanceof Error) return accounts;
      const account = accounts.find(
        (candidate) => candidate.name === accountName,
      );
      if (account === undefined)
        return new GmailConnectionError({
          operation: "select an unknown account",
        });
      const saved = await this.saveDefault(accountName);
      if (saved instanceof Error) return saved;
      return { ...account, isDefault: true };
    });
  }

  async prepare(input: {
    action?: "add" | "switch-default" | "reauthorize";
    accountName: string;
  }) {
    if (input.action !== "reauthorize")
      return `account${randomUUID().replaceAll("-", "")}`;
    const accounts = await this.list();
    if (accounts instanceof Error) return accounts;
    if (!accounts.some((account) => account.name === input.accountName)) {
      return new GmailConnectionError({
        operation: "reauthorize an unknown account",
      });
    }
    return input.accountName;
  }

  async complete(input: {
    connection: Connection;
    action?: "add" | "switch-default" | "reauthorize";
    expectedIdentity?: string;
  }) {
    return await this.actionQueue.run(async () => {
      const ref = {
        owner: input.connection.owner,
        integration: input.connection.integration,
        name: input.connection.name,
      };
      // Executor preserves old labels on re-mint; clear before probing so failure cannot leave a stale email.
      const cleared = await Effect.runPromise(
        this.executor.connections.update(ref, {
          identityLabel: "Unverified account",
        }),
      ).catch(
        (cause) =>
          new GmailConnectionError({ operation: "clear identity", cause }),
      );
      if (cleared instanceof Error) return cleared;
      const health = await Effect.runPromise(
        this.executor.connections.checkHealth(ref),
      ).catch(
        (cause) =>
          new GmailConnectionError({ operation: "verify identity", cause }),
      );
      if (health instanceof Error) return health;
      if (health.status !== "healthy" || health.identity === undefined) {
        return new GmailConnectionError({
          operation: "verify the authorized Gmail account; default unchanged",
        });
      }
      const updated = await Effect.runPromise(
        this.executor.connections.update(ref, {
          identityLabel: health.identity,
        }),
      ).catch(
        (cause) =>
          new GmailConnectionError({ operation: "save identity", cause }),
      );
      if (updated instanceof Error) return updated;
      const accounts = await this.list();
      if (accounts instanceof Error) return accounts;
      const mismatch =
        input.expectedIdentity !== undefined &&
        input.expectedIdentity.toLowerCase() !== health.identity.toLowerCase();
      const currentDefault = accounts.find((account) => account.isDefault);
      if (
        currentDefault === undefined ||
        (input.action === "switch-default" && !mismatch)
      ) {
        const saved = await this.saveDefault(String(updated.name));
        if (saved instanceof Error) return saved;
      }
      const defaultIdentityLabel =
        currentDefault === undefined ||
        (input.action === "switch-default" && !mismatch)
          ? health.identity
          : currentDefault.identityLabel;
      const isDefault =
        currentDefault === undefined ||
        currentDefault.name === updated.name ||
        (input.action === "switch-default" && !mismatch);
      const verb = input.action === "reauthorize" ? "Reauthorized" : "Added";
      return {
        accountName: String(updated.name),
        identityLabel: health.identity,
        defaultIdentityLabel,
        isDefault,
        message: `${verb} ${health.identity}. Default: ${defaultIdentityLabel}.${mismatch ? " The authorized account differs from the requested account; no default switch was applied." : ""}`,
      } satisfies GmailConnectionResult;
    });
  }

  private async saveDefault(accountName: string) {
    return await this.database.access((db) => {
      db.prepare(
        "INSERT INTO halo_gmail_defaults (user_id, connection_name) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET connection_name = excluded.connection_name",
      ).run(this.userId, accountName);
    });
  }
}
