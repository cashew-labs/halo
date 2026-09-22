import type { IncomingMessage, ServerResponse } from "node:http";
import { betterAuth, type Auth, type BetterAuthOptions } from "better-auth";
import { isAPIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { toNodeHandler } from "better-auth/node";
import { bearer, oneTimeToken } from "better-auth/plugins";
import * as errore from "errore";
import { OAuth2Client } from "google-auth-library";
import type { DatabaseClient, DatabaseService } from "../DatabaseService.js";

const loopbackHost = "127.0.0.1";
const desktopAuthStatePattern = /^[A-Za-z0-9_-]{32,128}$/u;

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

export class InvalidGoogleAccessTokenError extends errore.createTaggedError({
  name: "InvalidGoogleAccessTokenError",
  message: "Google access token is invalid",
}) {}

type AuthServiceOptions = {
  db: DatabaseService;
  origin: string;
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
  verifyGoogleAccessToken?: GoogleAccessTokenVerifier;
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
};

type DesktopAuthSession = AuthSession & {
  token: string;
};

type GoogleAccessTokenIdentity = {
  email: string;
  name: string;
  subject: string;
};

type AuthContext = Awaited<BetterAuth["$context"]>;
type GoogleAccountOwner = Awaited<
  ReturnType<AuthContext["internalAdapter"]["findAccountOwnerByKey"]>
>;

export type GoogleAccessTokenVerifier = (
  accessToken: string,
) => Promise<GoogleAccessTokenIdentity | Error>;

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
    // Desktop sign-in starts through RPC, so the Better Auth state cookie
    // would be set on Electron's fetch, not the system browser that finishes
    // Google OAuth. State still lives in the verification table.
    account: {
      skipStateCookieCheck: true,
    },
    onAPIError: {
      errorURL: new URL("/api/desktop-auth/error", options.origin).toString(),
    },
    socialProviders: {
      google: {
        clientId: options.googleClientId,
        clientSecret: options.googleClientSecret,
      },
    },
    plugins: [
      bearer(),
      oneTimeToken({
        disableClientRequest: true,
        expiresIn: 1,
        storeToken: "hashed",
      }),
    ],
  } satisfies BetterAuthOptions;
}

type AuthOptions = ReturnType<typeof authOptions>;
type BetterAuth = Auth<AuthOptions>;

export class AuthService {
  private readonly auth: BetterAuth;
  private readonly nodeHandler: NodeHandler;
  private readonly origin: string;
  private readonly verifyGoogleAccessToken: GoogleAccessTokenVerifier;

  private constructor(ctx: {
    auth: BetterAuth;
    nodeHandler: NodeHandler;
    origin: string;
    verifyGoogleAccessToken: GoogleAccessTokenVerifier;
  }) {
    this.auth = ctx.auth;
    this.nodeHandler = ctx.nodeHandler;
    this.origin = ctx.origin;
    this.verifyGoogleAccessToken = ctx.verifyGoogleAccessToken;
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
      verifyGoogleAccessToken:
        options.verifyGoogleAccessToken === undefined
          ? inspectGoogleAccessToken
          : options.verifyGoogleAccessToken,
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

    const result = await this.auth.api
      .signInSocial({
        returnHeaders: true,
        body: {
          provider: "google",
          callbackURL: completion.toString(),
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

    return serializeDesktopAuthSession({
      token: result.session.token,
      session: result.session,
      user: result.user,
    });
  }

  async signInWithGoogleAccessToken(accessToken: string) {
    const identity = await this.verifyGoogleAccessToken(accessToken);
    if (identity instanceof Error) return identity;

    const context = await this.auth.$context.catch(
      (cause) => new AuthServiceError({ detail: "load auth context", cause }),
    );
    if (context instanceof Error) return context;

    const owner = await context.internalAdapter
      .findAccountOwnerByKey({
        providerId: "google",
        accountId: identity.subject,
      })
      .catch(
        (cause) =>
          new AuthServiceError({ detail: "find Google account", cause }),
      );
    if (owner instanceof Error) return owner;

    const user = await googleUserForIdentity({
      context,
      identity,
      accessToken,
      owner,
    });
    if (user instanceof Error) return user;

    const session = await context.internalAdapter
      .createSession(user.id)
      .catch(
        (cause) =>
          new AuthServiceError({ detail: "create Google session", cause }),
      );
    if (session instanceof Error) return session;

    return serializeDesktopAuthSession({
      token: session.token,
      session,
      user,
    });
  }

  async getSession(headers: Headers) {
    const result = await this.auth.api
      .getSession({ headers })
      .catch((cause) => new AuthServiceError({ detail: "get session", cause }));
    if (result instanceof Error) return result;
    if (result === null) return undefined;

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
    } satisfies AuthSession;
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

function serializeDesktopAuthSession(input: {
  token: string;
  session: { id: string; userId: string; expiresAt: Date };
  user: {
    id: string;
    email: string;
    name: string;
    image?: string | null;
  };
}) {
  return {
    token: input.token,
    session: {
      id: input.session.id,
      userId: input.session.userId,
      expiresAt: input.session.expiresAt,
    },
    user: {
      id: input.user.id,
      email: input.user.email,
      name: input.user.name,
      image: input.user.image === null ? undefined : input.user.image,
    },
  } satisfies DesktopAuthSession;
}

async function googleUserForIdentity(ctx: {
  accessToken: string;
  context: AuthContext;
  identity: GoogleAccessTokenIdentity;
  owner: GoogleAccountOwner;
}) {
  if (ctx.owner !== null && ctx.owner.kind === "owned") return ctx.owner.user;

  const created = await ctx.context.internalAdapter
    .createOAuthUser(
      {
        email: ctx.identity.email,
        name: ctx.identity.name,
        emailVerified: true,
      },
      {
        providerId: "google",
        accountId: ctx.identity.subject,
        accessToken: ctx.accessToken,
      },
    )
    .catch(
      (cause) => new AuthServiceError({ detail: "create Google user", cause }),
    );
  if (created instanceof Error) return created;
  return created.user;
}

async function inspectGoogleAccessToken(accessToken: string) {
  const tokenInfo = await new OAuth2Client()
    .getTokenInfo(accessToken)
    .catch((cause) => new InvalidGoogleAccessTokenError({ cause }));
  if (tokenInfo instanceof Error) return tokenInfo;

  const email = tokenInfo.email;
  if (email === undefined) return new InvalidGoogleAccessTokenError();
  const subject = tokenInfo.sub;
  if (subject === undefined) return new InvalidGoogleAccessTokenError();

  return {
    email,
    name: email,
    subject,
  } satisfies GoogleAccessTokenIdentity;
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
