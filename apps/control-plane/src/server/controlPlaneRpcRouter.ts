import {
  controlPlaneContract,
  controlPlaneProtocolVersion,
  type ControlPlaneSession,
} from "@get-halo/shared/controlPlaneContract";
import { implement, ORPCError } from "@orpc/server";
import type {
  RequestHeadersHandlerPluginContext,
  ResponseHeadersHandlerPluginContext,
} from "@orpc/server/plugins";
import {
  type AuthSession,
  type AuthService,
  InvalidDesktopAuthCodeError,
  InvalidDesktopSignInRequestError,
} from "../auth/AuthService.js";
import type { WorkspaceService } from "../workspace/WorkspaceService.js";

export type ControlPlaneContext = RequestHeadersHandlerPluginContext &
  ResponseHeadersHandlerPluginContext & {
    auth: AuthService;
    workspace: WorkspaceService;
  };

const implementer =
  implement(controlPlaneContract).$context<ControlPlaneContext>();

const loadSession = implementer.middleware(async ({ context, next }) => {
  if (context.reqHeaders === undefined) {
    throw internalError(new Error("Request headers are unavailable"));
  }

  const session = await context.auth.getSession(context.reqHeaders);
  if (session instanceof Error) throw internalError(session);

  return await next({ context: { session } });
});

const os = implementer.use(({ context, next }) => {
  context.resHeaders?.set("cache-control", "no-store");
  return next();
});

const getServerInfo = os.server.info.handler(() => ({
  protocolVersion: controlPlaneProtocolVersion,
}));

const startDesktopSignIn = os.auth.start.handler(async ({ context, input }) => {
  const authorizationUrl = context.auth.desktopSignInUrl(input);

  if (authorizationUrl instanceof InvalidDesktopSignInRequestError) {
    throw badRequest(authorizationUrl);
  }

  return { authorizationUrl: authorizationUrl.toString() };
});

const exchangeDesktopAuthCode = os.auth.exchange.handler(
  async ({ context, input }) => {
    const session = await context.auth.exchangeDesktopAuthCode(input.code);

    if (session instanceof InvalidDesktopAuthCodeError) {
      throw badRequest(session);
    }

    if (session instanceof Error) throw internalError(session);

    return { ...serializeSession(session), token: session.token };
  },
);

const getAuthSession = os.auth.session
  .use(loadSession)
  .handler(({ context }) =>
    context.session === undefined
      ? undefined
      : serializeSession(context.session),
  );

const ensureWorkspace = os.workspace.ensure
  .use(loadSession)
  .handler(async ({ context }) => {
    if (context.session === undefined) {
      throw new ORPCError("UNAUTHORIZED", { message: "Sign in required" });
    }

    const workspace = await context.workspace.ensure(context.session.user.id);
    if (workspace instanceof Error) throw internalError(workspace);

    return {
      id: workspace.id,
      createdAt: workspace.createdAt.toISOString(),
    };
  });

export const controlPlaneRpcRouter = os.router({
  server: os.server.router({
    info: getServerInfo,
  }),
  auth: os.auth.router({
    start: startDesktopSignIn,
    exchange: exchangeDesktopAuthCode,
    session: getAuthSession,
  }),
  workspace: os.workspace.router({
    ensure: ensureWorkspace,
  }),
});

function serializeSession(session: AuthSession): ControlPlaneSession {
  return {
    session: {
      id: session.session.id,
      userId: session.session.userId,
      expiresAt: session.session.expiresAt.toISOString(),
    },
    user: session.user,
  };
}

function badRequest(error: Error) {
  return new ORPCError("BAD_REQUEST", {
    message: error.message,
    data: { message: error.message },
  });
}

function internalError(error: Error) {
  return new ORPCError("INTERNAL_SERVER_ERROR", { cause: error });
}
