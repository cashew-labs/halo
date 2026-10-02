import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, test as baseTest } from "vitest";
import {
  createExecutor,
  Effect,
  Tenant,
  Subject,
  Owner,
  ConnectionName,
  IntegrationSlug,
  AuthTemplateSlug,
  OAuthState,
  firstPartyOAuthClientSlug,
} from "@executor-js/sdk/core";
import { openApiPlugin } from "@executor-js/plugin-openapi/core";
import { FilesystemService } from "../../filesystem/FilesystemService.js";
import { DatabaseClient } from "../../storage/DatabaseClient.js";
import { FileCredentialVault } from "./FileCredentialVault.js";
import { createExecutorCredentialProvider } from "./createExecutorCredentialProvider.js";
import { createExecutorDatabase } from "./createExecutorDatabase.js";
import { GmailConnections } from "./GmailConnections.js";

const gmailTest = baseTest.extend<{
  gmail: Awaited<ReturnType<typeof createGmailFixture>>;
}>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest fixture callbacks require destructured parameters.
  gmail: async ({}, use) => {
    await using fixture = await createGmailFixture();
    await use(fixture);
  },
});

async function createGmailFixture() {
  const parent = path.resolve(
    import.meta.dirname,
    "../../../../../tmp/gmail-multi-account/tests",
  );
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, "accounts-"));
  const filesystem = new FilesystemService();
  const database = await DatabaseClient.open({ directory, filesystem });
  if (database instanceof Error) throw database;
  const provider = http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/token") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const code = new URLSearchParams(Buffer.concat(chunks).toString()).get(
        "code",
      );
      if (code === "failed") {
        response.writeHead(400);
        response.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      response.end(
        JSON.stringify({
          access_token: code,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "gmail",
        }),
      );
      return;
    }
    if (request.headers.authorization === "Bearer unhealthy") {
      response.writeHead(401);
      response.end(JSON.stringify({ error: "expired" }));
      return;
    }
    response.end(
      JSON.stringify({
        emailAddress: `${request.headers.authorization?.slice(7)}@example.com`,
      }),
    );
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  // SAFETY: the listening TCP server has an AddressInfo after the listening event.
  const origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  const executor = await Effect.runPromise(
    createExecutor({
      tenant: Tenant.make("test"),
      subject: Subject.make("alice"),
      plugins: [openApiPlugin()] as const,
      providers: [
        createExecutorCredentialProvider(
          new FileCredentialVault({
            filesystem,
            directory: path.join(directory, "credentials"),
          }),
        ),
      ],
      redirectUri: `${origin}/callback`,
      firstPartyOAuthClients: [
        {
          name: "test",
          authorizationUrl: `${origin}/authorize`,
          tokenUrl: `${origin}/token`,
          clientId: "test",
          clientSecret: "test",
          integrations: [IntegrationSlug.make("google_gmail")],
          allowedScopes: ["gmail"],
        },
      ],
      db: ({ tables }) =>
        Effect.promise(async () => {
          const db = await createExecutorDatabase(database, tables);
          if (db instanceof Error) throw db;
          return db;
        }),
      onElicitation: "accept-all",
    }),
  );
  await Effect.runPromise(
    executor.openapi.addSpec({
      slug: "google_gmail",
      spec: {
        kind: "blob",
        value: JSON.stringify({
          openapi: "3.0.0",
          info: { title: "Gmail", version: "1" },
          servers: [{ url: origin }],
          paths: {
            "/profile": {
              get: {
                operationId: "profile",
                responses: {
                  "200": {
                    description: "Profile",
                    content: {
                      "application/json": {
                        schema: {
                          type: "object",
                          properties: { emailAddress: { type: "string" } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      },
      authenticationTemplate: [
        {
          kind: "oauth2",
          slug: "oauth2",
          authorizationUrl: `${origin}/authorize`,
          tokenUrl: `${origin}/token`,
          scopes: ["gmail"],
        },
      ],
      healthCheck: {
        operation: "profile.getOperation",
        identityField: "emailAddress",
      },
    }),
  );
  const gmail = new GmailConnections({ executor, database, userId: "alice" });
  return {
    gmail,
    freshService: () =>
      new GmailConnections({ executor, database, userId: "alice" }),
    async authorize(input: {
      email: string;
      action?: "add" | "switch-default" | "reauthorize";
      accountName?: string;
      expectedIdentity?: string;
      cancel?: boolean;
    }) {
      const name = await gmail.prepare({
        action: input.action,
        accountName: input.accountName ?? "default",
      });
      if (name instanceof Error) return name;
      const started = await Effect.runPromise(
        executor.oauth.start({
          client: firstPartyOAuthClientSlug("test"),
          clientOwner: Owner.make("org"),
          owner: Owner.make("user"),
          integration: IntegrationSlug.make("google_gmail"),
          template: AuthTemplateSlug.make("oauth2"),
          name: ConnectionName.make(name),
        }),
      );
      if (started.status !== "redirect")
        throw new Error("Expected authorization");
      if (input.cancel) {
        await Effect.runPromise(executor.oauth.cancel(started.state));
        return undefined;
      }
      const connection = await Effect.runPromise(
        executor.oauth.complete({
          state: OAuthState.make(started.state),
          code: input.email,
        }),
      ).catch((cause) => new Error("Authorization failed", { cause }));
      if (connection instanceof Error) return connection;
      return await gmail.complete({
        connection,
        action: input.action,
        expectedIdentity: input.expectedIdentity,
      });
    },
    async legacy() {
      const connection = await Effect.runPromise(
        executor.connections.create({
          owner: Owner.make("user"),
          name: ConnectionName.make("default"),
          integration: IntegrationSlug.make("google_gmail"),
          template: AuthTemplateSlug.make("oauth2"),
          value: "legacy",
          identityLabel: "legacy@example.com",
        }),
      );
      return connection;
    },
    async [Symbol.asyncDispose]() {
      await Effect.runPromise(executor.close());
      const closed = await database.close();
      if (closed instanceof Error) throw closed;
      await filesystem.close();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

gmailTest(
  "adds accounts, persists a default, and switches without losing credentials",
  async ({ gmail: fixture }) => {
    const first = await fixture.authorize({ email: "first" });
    expect(first).toMatchObject({
      identityLabel: "first@example.com",
      isDefault: true,
    });
    const second = await fixture.authorize({ email: "second" });
    expect(second).toMatchObject({
      identityLabel: "second@example.com",
      isDefault: false,
      defaultIdentityLabel: "first@example.com",
    });
    if (second === undefined || second instanceof Error)
      throw new Error("Expected second account");
    expect(await fixture.gmail.setDefault(second.accountName)).toMatchObject({
      isDefault: true,
    });
    expect(await fixture.freshService().list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identityLabel: "first@example.com",
          isDefault: false,
        }),
        expect.objectContaining({
          identityLabel: "second@example.com",
          isDefault: true,
        }),
      ]),
    );
  },
);

gmailTest(
  "reauthorization reports the actual identity and removes a stale label",
  async ({ gmail: fixture }) => {
    const first = await fixture.authorize({ email: "first" });
    if (first === undefined || first instanceof Error)
      throw new Error("Expected first account");
    const reauthorized = await fixture.authorize({
      email: "different",
      action: "reauthorize",
      accountName: first.accountName,
      expectedIdentity: "first@example.com",
    });
    expect(reauthorized).toMatchObject({
      identityLabel: "different@example.com",
    });
    expect(await fixture.gmail.list()).toMatchObject([
      { identityLabel: "different@example.com" },
    ]);
    expect(reauthorized).toMatchObject({
      message: expect.stringContaining("differs"),
    });
  },
);

gmailTest(
  "withholds an unexpected default switch and applies an explicit matching switch",
  async ({ gmail: fixture }) => {
    await fixture.authorize({ email: "first" });
    expect(
      await fixture.authorize({
        email: "unexpected",
        action: "switch-default",
        expectedIdentity: "wanted@example.com",
      }),
    ).toMatchObject({
      isDefault: false,
      defaultIdentityLabel: "first@example.com",
    });
    expect(
      await fixture.authorize({
        email: "wanted",
        action: "switch-default",
        expectedIdentity: "wanted@example.com",
      }),
    ).toMatchObject({
      isDefault: true,
      defaultIdentityLabel: "wanted@example.com",
    });
  },
);

gmailTest(
  "cancellation and token failure preserve accounts and default",
  async ({ gmail: fixture }) => {
    await fixture.authorize({ email: "first" });
    await fixture.authorize({
      email: "cancelled",
      action: "switch-default",
      cancel: true,
    });
    expect(
      await fixture.authorize({ email: "failed", action: "switch-default" }),
    ).toBeInstanceOf(Error);
    expect(await fixture.gmail.list()).toMatchObject([
      { identityLabel: "first@example.com", isDefault: true },
    ]);
  },
);

gmailTest(
  "legacy single default survives adding an account",
  async ({ gmail: fixture }) => {
    await fixture.legacy();
    expect(await fixture.gmail.list()).toMatchObject([
      { identityLabel: "legacy@example.com", isDefault: true },
    ]);
    expect(await fixture.authorize({ email: "new" })).toMatchObject({
      isDefault: false,
      defaultIdentityLabel: "legacy@example.com",
    });
  },
);

gmailTest(
  "failed identity verification clears stale labels without switching defaults",
  async ({ gmail: fixture }) => {
    await fixture.authorize({ email: "first" });
    expect(
      await fixture.authorize({ email: "unhealthy", action: "switch-default" }),
    ).toBeInstanceOf(Error);
    expect(await fixture.gmail.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identityLabel: "first@example.com",
          isDefault: true,
        }),
        expect.objectContaining({
          identityLabel: "Unverified account",
          isDefault: false,
        }),
      ]),
    );
  },
);
