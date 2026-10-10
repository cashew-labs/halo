import { Effect, Owner, isToolResult } from "@executor-js/sdk/core";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import type { IntegrationService } from "../integrations/IntegrationService.js";
import type { IntegrationJson } from "@get-halo/shared/controlPlaneContract";

type GmailHistoryArguments = {
  userId: string;
  startHistoryId: string;
  historyTypes: string[];
  maxResults: number;
  pageToken?: string;
};
const historyId = Type.String({ pattern: "^[0-9]+$", maxLength: 40 });
const profileSchema = Type.Object({
  emailAddress: Type.String({ minLength: 3 }),
  historyId,
});
const watchSchema = Type.Object({
  historyId,
  expiration: Type.String({ pattern: "^[0-9]+$" }),
});
const messageSchema = Type.Object({
  id: Type.String(),
  threadId: Type.Optional(Type.String()),
  labelIds: Type.Optional(Type.Array(Type.String())),
  snippet: Type.Optional(Type.String()),
  payload: Type.Optional(
    Type.Object({
      headers: Type.Optional(
        Type.Array(Type.Object({ name: Type.String(), value: Type.String() })),
      ),
    }),
  ),
});
const historySchema = Type.Object({
  historyId,
  nextPageToken: Type.Optional(Type.String()),
  history: Type.Optional(
    Type.Array(
      Type.Object({
        id: historyId,
        messagesAdded: Type.Optional(
          Type.Array(Type.Object({ message: messageSchema })),
        ),
      }),
    ),
  ),
});
export type GmailMessage = Static<typeof messageSchema>;
export type GmailAccount = { ownerId: string; connectionAddress: string };
export class GmailApiError extends errore.createTaggedError({
  name: "GmailApiError",
  message: "Gmail request failed ($status): $detail",
}) {}

/** Uses the existing user-scoped Executor connection, including its OAuth refresh. */
export class GmailApi {
  private readonly integrations: IntegrationService;
  constructor(ctx: { integrations: IntegrationService }) {
    this.integrations = ctx.integrations;
  }
  async profile(account: GmailAccount) {
    return await this.call(
      account,
      "users.getProfile",
      { userId: "me" },
      profileSchema,
    );
  }
  async watch(account: GmailAccount, topic: string) {
    return await this.call(
      account,
      "users.watch",
      {
        userId: "me",
        body: {
          topicName: topic,
          labelIds: ["INBOX"],
          labelFilterBehavior: "include",
        },
      },
      watchSchema,
    );
  }
  async stop(account: GmailAccount) {
    return await this.call(
      account,
      "users.stop",
      { userId: "me" },
      Type.Object({}),
    );
  }
  async history(account: GmailAccount, cursor: string, pageToken?: string) {
    const args: GmailHistoryArguments = {
      userId: "me",
      startHistoryId: cursor,
      historyTypes: ["messageAdded"],
      maxResults: 100,
    };
    if (pageToken !== undefined) args.pageToken = pageToken;
    return await this.call(account, "users.history.list", args, historySchema);
  }
  async message(account: GmailAccount, id: string) {
    return await this.call(
      account,
      "users.messages.get",
      {
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      },
      messageSchema,
    );
  }

  private async call<T extends TSchema>(
    account: GmailAccount,
    operation: string,
    args: Record<string, IntegrationJson>,
    schema: T,
  ) {
    return await this.integrations.withGmailUser(
      account.ownerId,
      (executor) =>
        Effect.gen(function* () {
          const connections = yield* executor.connections.list({
            owner: Owner.make("user"),
          });
          const connection = connections.find(
            (candidate) =>
              candidate.address === account.connectionAddress &&
              candidate.integration === "google_gmail",
          );
          if (connection === undefined)
            return new GmailApiError({
              status: "401",
              detail: "Reconnect the selected Gmail connection",
            });
          const tools = yield* executor.tools.list({
            integration: connection.integration,
            owner: connection.owner,
            connection: connection.name,
          });
          const tool = tools.find(
            (candidate) =>
              candidate.name === `gmail.${operation}` ||
              candidate.name === operation,
          );
          if (tool === undefined)
            return new GmailApiError({
              status: "0",
              detail: `The Gmail connection does not expose ${operation}`,
            });
          const result = yield* executor.execute(tool.address, args);
          if (isToolResult(result) && !result.ok)
            return new GmailApiError({
              status: String(result.error.status ?? 0),
              detail:
                result.error.status === 401 || result.error.status === 403
                  ? "Reconnect Gmail and grant mailbox access"
                  : result.error.code,
            });
          const data = isToolResult(result) && result.ok ? result.data : result;
          const normalized = operation === "users.stop" ? {} : data;
          if (!Value.Check(schema, normalized))
            return new GmailApiError({
              status: "0",
              detail: "Unexpected Gmail response",
            });
          return normalized;
        }),
      AbortSignal.timeout(20_000),
    );
  }
}
