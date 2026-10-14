import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { betterAuth, type Auth, type BetterAuthOptions } from "better-auth";
import { isAPIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { toNodeHandler } from "better-auth/node";
import { bearer, oneTimeToken } from "better-auth/plugins";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { apiKey } from "@better-auth/api-key";
import * as errore from "errore";
import type { DatabaseClient, DatabaseService } from "../DatabaseService.js";
import type { SignInAllowlist } from "./SignInAllowlist.js";
import { signInHooks } from "./signInHooks.js";

const loopbackHost = "127.0.0.1";
const desktopAuthStatePattern = /^[A-Za-z0-9_-]{32,128}$/u;
const workspaceKeyConfigId = "workspace-runtime";

class AuthServiceError extends errore.createTaggedError({
  name: "AuthServiceError",
  message: "Auth service failed: $detail",
}) {}

export class InvalidDesktopSignInRequestError extends errore.createTaggedError({
  name: "InvalidDesktopSignInRequestError",
  message: "Desktop sign-in callback or state is invalid",
}) {}

export class DesktopAuthRequiredError extends errore.createTaggedError({
  name: "DesktopAuthRequiredError",
  message: "Google sign-in has not completed",
}) {}

export class InvalidDesktopAuthCodeError extends errore.createTaggedError({
  name: "InvalidDesktopAuthCodeError",
  message: "Desktop sign-in code is invalid or expired",
}) {}

export class WorkspaceAuthenticationRequiredError extends errore.createTaggedError(
  {
    name: "WorkspaceAuthenticationRequiredError",
    message: "A valid workspace service token is required",
  },
) {}

type AuthServiceOptions = {
  db: DatabaseService;
  origin: string;
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
  /** Restricts who can sign in; unset lets anyone sign in. */
  signInAllowlist?: SignInAllowlist;
  /** Users offered the desktop staging toggle; production sets it. */
  stagingTesters?: SignInAllowlist;
};

type DesktopSignInRequest = {
  callback: string;
  state: string;
};

type AuthUser = {
  id: string;
  email: string;
  name: string;
  image: string | undefined;
};

export type AuthSession = {
  session: {
    id: string;
    userId: string;
    expiresAt: Date;
  };
  user: AuthUser;
  /** Whether the desktop app offers this user its staging toggle. */
  stagingAccess: boolean;
};

type DesktopAuthSession = AuthSession & {
  token: string;
};

type NodeHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;

function authOptions(options: AuthServiceOptions, database: DatabaseClient) {
  return {
    baseURL: options.origin,
    secret: options.secret,
    database,
    trustedOrigins: [options.origin],
    // Machine credentials are managed only by WorkspaceService, never by clients.
    disabledPaths: [
      "/api-key/create",
      "/api-key/get",
      "/api-key/list",
      "/api-key/update",
      "/api-key/delete",
    ],
    // Desktop sign-in starts through RPC, so the Better Auth state cookie
    // would be set on Electron's fetch, not the system browser that finishes
    // Google OAuth. State still lives in the verification table.
    account: {
      skipStateCookieCheck: true,
    },
    onAPIError: {
      errorURL: new URL("/api/desktop-auth/error", options.origin).toString(),
    },
    databaseHooks: signInHooks({
      allowlist: options.signInAllowlist,
      findUserEmail: async (userId) => await findUserEmail(database, userId),
    }),
    socialProviders: {
      google: {
        clientId: options.googleClientId,
        clientSecret: options.googleClientSecret,
      },
    },
    plugins: [
      apiKey({
        configId: workspaceKeyConfigId,
        defaultPrefix: "halo_workspace_",
        enableSessionForAPIKeys: false,
        rateLimit: { enabled: false },
        // Idle pause must not expire the credential needed when work resumes.
        // oxlint-disable-next-line unicorn/no-null -- Better Auth uses null for no expiry.
        keyExpiration: { defaultExpiresIn: null },
      }),
      bearer(),
      oneTimeToken({
        disableClientRequest: true,
        expiresIn: 1,
        storeToken: "hashed",
      }),
    ],
  } satisfies BetterAuthOptions;
}

async function findUserEmail(database: DatabaseClient, userId: string) {
  if (database instanceof DatabaseSync) {
    return errore.try({
      // SAFETY: The query selects only the user's email text column.
      try: () =>
        (
          database
            .prepare('SELECT email FROM "user" WHERE id = ?')
            .get(userId) as { email: string } | undefined
        )?.email,
      catch: (cause) =>
        new AuthServiceError({ detail: "load the signing-in user", cause }),
    });
  }
  // coverage-exempt: Postgres runs only in deployed stacks; the SQLite branch above is the same query, tested with the hooks.
  const selected = await database
    .query<{ email: string }>('SELECT email FROM "user" WHERE id = $1', [
      userId,
    ])
    .catch(
      (cause) =>
        new AuthServiceError({ detail: "load the signing-in user", cause }),
    );
  if (selected instanceof Error) return selected;
  return selected.rows[0]?.email;
}

type AuthOptions = ReturnType<typeof authOptions>;
type BetterAuth = Auth<AuthOptions>;

export class AuthService {
  private readonly auth: BetterAuth;
  private readonly nodeHandler: NodeHandler;
  private readonly origin: string;
  private readonly workspaceEncryptionKey: string;
  private readonly signInAllowlist: SignInAllowlist | undefined;
  private readonly stagingTesters: SignInAllowlist | undefined;

  private constructor(ctx: {
    auth: BetterAuth;
    nodeHandler: NodeHandler;
    origin: string;
    workspaceEncryptionKey: string;
    signInAllowlist: SignInAllowlist | undefined;
    stagingTesters: SignInAllowlist | undefined;
  }) {
    this.signInAllowlist = ctx.signInAllowlist;
    this.stagingTesters = ctx.stagingTesters;
    this.auth = ctx.auth;
    this.nodeHandler = ctx.nodeHandler;
    this.origin = ctx.origin;
    this.workspaceEncryptionKey = ctx.workspaceEncryptionKey;
  }

  static async start(options: AuthServiceOptions) {
    const config = authOptions(options, options.db.client);
    const migrations = await getMigrations(config).catch(
      (cause) => new AuthServiceError({ detail: "prepare migrations", cause }),
    );
    if (migrations instanceof Error) return migrations;

    const migrated = await migrations
      .runMigrations()
      .catch(
        (cause) => new AuthServiceError({ detail: "run migrations", cause }),
      );
    if (migrated instanceof Error) return migrated;

    const auth = betterAuth(config);

    return new AuthService({
      auth,
      nodeHandler: toNodeHandler(auth),
      origin: options.origin,
      workspaceEncryptionKey: `workspace-runtime:${options.secret}`,
      signInAllowlist: options.signInAllowlist,
      stagingTesters: options.stagingTesters,
    });
  }

  async handle(request: Request) {
    return await this.auth
      .handler(request)
      .catch(
        (cause) => new AuthServiceError({ detail: "handle request", cause }),
      );
  }

  async handleHttp(request: IncomingMessage, response: ServerResponse) {
    return await this.nodeHandler(request, response).catch(
      (cause) => new AuthServiceError({ detail: "handle request", cause }),
    );
  }

  async startDesktopSignIn(request: DesktopSignInRequest) {
    const signIn = parseDesktopSignInRequest(request);
    if (signIn instanceof Error) return signIn;

    const completion = new URL("/api/desktop-auth/complete", this.origin);
    completion.searchParams.set("callback", signIn.callback.toString());
    completion.searchParams.set("state", signIn.state);
    const failure = new URL(completion);
    failure.pathname = "/api/desktop-auth/error";

    const result = await this.auth.api
      .signInSocial({
        returnHeaders: true,
        body: {
          provider: "google",
          callbackURL: completion.toString(),
          errorCallbackURL: failure.toString(),
        },
      })
      .catch(
        (cause) =>
          new AuthServiceError({ detail: "start desktop sign-in", cause }),
      );
    if (result instanceof Error) return result;

    const authorizationUrl = result.response.url;
    if (authorizationUrl === undefined || authorizationUrl === "") {
      return new AuthServiceError({ detail: "start desktop sign-in" });
    }

    return {
      authorizationUrl,
      headers: result.headers,
    };
  }

  async completeDesktopSignIn(headers: Headers, request: DesktopSignInRequest) {
    const signIn = parseDesktopSignInRequest(request);
    if (signIn instanceof Error) return signIn;

    const code = await this.createDesktopAuthCode(headers);
    if (code instanceof Error) return code;

    signIn.callback.searchParams.set("code", code);
    signIn.callback.searchParams.set("state", signIn.state);
    return signIn.callback;
  }

  failDesktopSignIn(request: DesktopSignInRequest, error: string) {
    const signIn = parseDesktopSignInRequest(request);
    if (signIn instanceof Error) return signIn;
    signIn.callback.searchParams.set("error", error);
    signIn.callback.searchParams.set("state", signIn.state);
    return signIn.callback;
  }

  async exchangeDesktopAuthCode(code: string) {
    const result = await this.auth.api
      .verifyOneTimeToken({ body: { token: code } })
      .catch((cause: unknown) => {
        if (isAPIError(cause) && cause.statusCode === 400) {
          return new InvalidDesktopAuthCodeError();
        }
        return new AuthServiceError({
          detail: "exchange desktop auth code",
          cause,
        });
      });
    if (result instanceof Error) return result;

    return {
      token: result.session.token,
      session: {
        id: result.session.id,
        userId: result.session.userId,
        expiresAt: result.session.expiresAt,
      },
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        image: result.user.image === null ? undefined : result.user.image,
      },
      stagingAccess: await this.hasStagingAccess(result.user.email),
    } satisfies DesktopAuthSession;
  }

  async getSession(headers: Headers) {
    const result = await this.auth.api
      .getSession({ headers })
      .catch((cause) => new AuthServiceError({ detail: "get session", cause }));
    if (result instanceof Error) return result;
    if (result === null) return undefined;
    const allowed = await this.stillAllowed(result.user.email);
    if (allowed instanceof Error) return allowed;
    if (!allowed) return undefined;

    return {
      session: {
        id: result.session.id,
        userId: result.session.userId,
        expiresAt: result.session.expiresAt,
      },
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        image: result.user.image === null ? undefined : result.user.image,
      },
      stagingAccess: await this.hasStagingAccess(result.user.email),
    } satisfies AuthSession;
  }

  // An unreadable list hides the toggle; it never affects sign-in.
  private async hasStagingAccess(email: string) {
    if (this.stagingTesters === undefined) return false;
    const allowed = await this.stagingTesters.allows(email);
    if (allowed instanceof Error) console.error(allowed);
    return allowed === true;
  }

  // Sessions from before an email left the allowlist, or from before the
  // allowlist existed, stop working at the next refresh of the list. An
  // unreadable list is an outage, not a sign-out, so clients keep their token.
  private async stillAllowed(email: string) {
    if (this.signInAllowlist === undefined) return true;
    return await this.signInAllowlist.allows(email);
  }

  async findUserEmail(userId: string) {
    const context = await this.auth.$context;
    const user = await context.internalAdapter
      .findUserById(userId)
      .catch((cause) => new AuthServiceError({ detail: "find user", cause })); // coverage-exempt: Auth database outage wrapper; the found and missing user paths run through the owner's agent in temp tests.
    if (user instanceof Error) return user;
    return user?.email;
  }

  async createWorkspaceSocketTicket(headers: Headers, clientId: string) {
    const session = await this.auth.api.getSession({ headers }).catch(
      (cause) => new AuthServiceError({ detail: "read socket session", cause }), // coverage-exempt: External auth/database outage wrapper; success and authorization failures use the real database in integration tests.
    );
    if (session instanceof Error) return session;
    if (session === null) return undefined;
    const allowed = await this.stillAllowed(session.user.email);
    if (allowed instanceof Error) return allowed;
    if (!allowed) return undefined;
    const ticket = crypto.randomBytes(32).toString("base64url");
    const context = await this.auth.$context;
    const cleaned = await context.adapter
      .deleteMany({
        model: "verification",
        where: [
          {
            field: "identifier",
            operator: "starts_with",
            value: "workspace-socket:",
          },
          { field: "expiresAt", operator: "lt", value: new Date() },
        ],
      })
      .catch(
        (cause) =>
          new AuthServiceError({ detail: "expire socket tickets", cause }), // coverage-exempt: External auth/database outage wrapper; success and authorization failures use the real database in integration tests.
      );
    if (cleaned instanceof Error) return cleaned;
    const stored = await context.internalAdapter
      .createVerificationValue({
        identifier: socketTicketIdentifier(ticket),
        value: JSON.stringify({
          sessionToken: session.session.token,
          clientId,
        }),
        expiresAt: new Date(Date.now() + 60_000),
      })
      .catch(
        (cause) =>
          new AuthServiceError({ detail: "issue socket ticket", cause }), // coverage-exempt: External auth/database outage wrapper; success and authorization failures use the real database in integration tests.
      );
    if (stored instanceof Error) return stored;
    return { ticket };
  }

  async consumeWorkspaceSocketTicket(ticket: string) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(ticket)) return undefined;
    const context = await this.auth.$context;
    const stored = await context.internalAdapter
      .consumeVerificationValue(socketTicketIdentifier(ticket))
      .catch(
        (cause) =>
          new AuthServiceError({ detail: "consume socket ticket", cause }), // coverage-exempt: External auth/database outage wrapper; success and authorization failures use the real database in integration tests.
      );
    if (stored instanceof Error) return stored;
    if (stored === null) return undefined;
    // SAFETY: Only createWorkspaceSocketTicket writes this namespaced value.
    const value = JSON.parse(stored.value) as {
      sessionToken: string;
      clientId: string;
    };
    const session = await this.getSession(
      new Headers({ authorization: `Bearer ${value.sessionToken}` }),
    );
    if (session instanceof Error) return session;
    if (
      session === undefined ||
      session.session.expiresAt.getTime() <= Date.now()
    )
      return undefined;
    return { ...session, clientId: value.clientId };
  }

  async createWorkspaceCredential(ctx: {
    userId: string;
    workspaceId: string;
  }) {
    const credential = await this.auth.api
      .createApiKey({
        body: {
          configId: workspaceKeyConfigId,
          userId: ctx.userId,
          permissions: { workspace: [ctx.workspaceId] },
        },
      })
      .catch(
        (cause) =>
          new AuthServiceError({ detail: "issue workspace key", cause }),
      );
    if (credential instanceof Error) return credential;
    // Better Auth stores a hash. Encrypt the assignable copy so retries can reuse it.
    const encryptedKey = await symmetricEncrypt({
      key: this.workspaceEncryptionKey,
      data: credential.key,
    }).catch(
      (cause) =>
        new AuthServiceError({ detail: "encrypt workspace key", cause }),
    );
    if (encryptedKey instanceof Error) {
      const revoked = await this.revokeWorkspaceCredential({
        userId: ctx.userId,
        keyId: credential.id,
      });
      return revoked instanceof Error ? revoked : encryptedKey;
    }
    return { keyId: credential.id, encryptedKey };
  }

  async readWorkspaceToken(encryptedKey: string) {
    return await symmetricDecrypt({
      key: this.workspaceEncryptionKey,
      data: encryptedKey,
    }).catch(
      (cause) =>
        new AuthServiceError({ detail: "decrypt workspace key", cause }),
    );
  }

  async verifyWorkspaceToken(headers: Headers) {
    const authorization = headers.get("authorization");
    if (authorization === null || !authorization.startsWith("Bearer "))
      return new WorkspaceAuthenticationRequiredError();
    const verified = await this.auth.api
      .verifyApiKey({
        body: { configId: workspaceKeyConfigId, key: authorization.slice(7) },
      })
      .catch(
        (cause) =>
          new AuthServiceError({ detail: "verify workspace key", cause }),
      );
    if (verified instanceof Error) return verified;
    if (!verified.valid || verified.key === null)
      return new WorkspaceAuthenticationRequiredError();
    return { keyId: verified.key.id, userId: verified.key.referenceId };
  }

  async revokeWorkspaceCredential(ctx: { userId: string; keyId: string }) {
    const revoked = await this.auth.api
      .updateApiKey({
        body: { configId: workspaceKeyConfigId, ...ctx, enabled: false },
      })
      .catch(
        (cause) =>
          new AuthServiceError({ detail: "revoke workspace key", cause }),
      );
    if (revoked instanceof Error) return revoked;
  }

  private async createDesktopAuthCode(headers: Headers) {
    const session = await this.getSession(headers);

    if (session instanceof Error) return session;
    if (session === undefined) return new DesktopAuthRequiredError();

    return await this.auth.api
      .generateOneTimeToken({ headers })
      .then((result) => result.token)
      .catch(
        (cause) =>
          new AuthServiceError({ detail: "create desktop auth code", cause }),
      );
  }
}

function parseDesktopSignInRequest(request: DesktopSignInRequest) {
  if (!desktopAuthStatePattern.test(request.state)) {
    return new InvalidDesktopSignInRequestError();
  }

  const callback = errore.try({
    try: () => new URL(request.callback),
    catch: (cause) => new InvalidDesktopSignInRequestError({ cause }),
  });

  if (callback instanceof Error) return callback;

  if (callback.protocol !== "http:") {
    return new InvalidDesktopSignInRequestError();
  }

  if (callback.hostname !== loopbackHost) {
    return new InvalidDesktopSignInRequestError();
  }

  if (callback.port === "") return new InvalidDesktopSignInRequestError();

  if (callback.username !== "" || callback.password !== "") {
    return new InvalidDesktopSignInRequestError();
  }

  if (callback.search !== "" || callback.hash !== "") {
    return new InvalidDesktopSignInRequestError();
  }

  return { callback, state: request.state };
}

function socketTicketIdentifier(ticket: string) {
  return `workspace-socket:${crypto.createHash("sha256").update(ticket).digest("hex")}`;
}
