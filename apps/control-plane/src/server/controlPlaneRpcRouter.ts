import {
  controlPlaneContract,
  controlPlaneProtocolVersion,
  controlPlaneSupportedProtocols,
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
  WorkspaceAuthenticationRequiredError,
} from "../auth/AuthService.js";
import type { WorkspaceService } from "../workspace/WorkspaceService.js";
import {
  IntegrationToolNotFoundError,
  IntegrationSetupError,
  type IntegrationService,
} from "../integrations/IntegrationService.js";

export type ControlPlaneContext = RequestHeadersHandlerPluginContext &
  ResponseHeadersHandlerPluginContext & {
    build?: { version: string; revision: string };
    publicOrigin: string;
    auth: AuthService;
    workspace: WorkspaceService;
    integrations?: IntegrationService;
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

const loadRuntime = implementer.middleware(async ({ context, next }) => {
  const identity = await context.workspace.authenticateRuntimeOwner(
    context.reqHeaders ?? new Headers(),
  );
  if (identity instanceof WorkspaceAuthenticationRequiredError)
    throw new ORPCError("UNAUTHORIZED");
  if (identity instanceof Error) throw internalError(identity);
  if (context.integrations === undefined)
    throw new ORPCError("SERVICE_UNAVAILABLE");
  return await next({
    context: {
      ownerUserId: identity.ownerUserId,
      integrations: context.integrations,
    },
  });
});

const loadIntegrationUser = implementer.middleware(
  async ({ context, next }) => {
    const headers = context.reqHeaders ?? new Headers();
    const origin = headers.get("origin");
    // Browser cookies require same-origin requests. Desktop bearer sessions are not ambient.
    if (origin !== null && origin !== context.publicOrigin)
      throw new ORPCError("FORBIDDEN");
    if (origin === null && !headers.get("authorization")?.startsWith("Bearer "))
      throw new ORPCError("FORBIDDEN");
    const session = await context.auth.getSession(headers);
    if (session instanceof Error) throw internalError(session);
    if (session === undefined) throw new ORPCError("UNAUTHORIZED");
    if (context.integrations === undefined)
      throw new ORPCError("SERVICE_UNAVAILABLE");
    return await next({
      context: {
        ownerUserId: session.user.id,
        integrations: context.integrations,
      },
    });
  },
);

const loadIntegrationOwner = implementer.middleware(
  async ({ context, next }) => {
    const headers = context.reqHeaders ?? new Headers();
    const session = await context.auth.getSession(headers);
    if (session instanceof Error) throw internalError(session);
    const runtime =
      session === undefined
        ? await context.workspace.authenticateRuntimeOwner(headers)
        : undefined;
    if (runtime instanceof WorkspaceAuthenticationRequiredError)
      throw new ORPCError("UNAUTHORIZED");
    if (runtime instanceof Error) throw internalError(runtime);
    if (context.integrations === undefined)
      throw new ORPCError("SERVICE_UNAVAILABLE");
    if (
      session !== undefined &&
      headers.get("origin") !== null &&
      headers.get("origin") !== context.publicOrigin
    )
      throw new ORPCError("FORBIDDEN");
    return await next({
      context: {
        ownerUserId: session?.user.id ?? runtime!.ownerUserId,
        integrations: context.integrations,
      },
    });
  },
);

function integrationError(result: Error): never {
  if (result instanceof IntegrationSetupError) throw badRequest(result);
  if (result instanceof IntegrationToolNotFoundError)
    throw new ORPCError("NOT_FOUND");
  throw internalError(result);
}

const getServerInfo = os.server.info.handler(({ context }) => ({
  protocolVersion: controlPlaneProtocolVersion,
  supportedProtocols: controlPlaneSupportedProtocols,
  build: context.build,
}));

const startDesktopSignIn = os.auth.start.handler(async ({ context, input }) => {
  const started = await context.auth.startDesktopSignIn(input);

  if (started instanceof InvalidDesktopSignInRequestError) {
    throw badRequest(started);
  }

  if (started instanceof Error) throw internalError(started);

  return { authorizationUrl: started.authorizationUrl };
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
      ? { status: "signed-out" as const }
      : {
          status: "signed-in" as const,
          session: serializeSession(context.session),
        },
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
  integrations: os.integrations.router({
    catalog: os.integrations.catalog
      .use(loadIntegrationOwner)
      .handler(async ({ context }) => {
        const result = await context.integrations.catalog(context.ownerUserId);
        if (result instanceof Error) return integrationError(result);
        return result;
      }),
    startSetup: os.integrations.startSetup
      .use(loadIntegrationOwner)
      .handler(async ({ context, input }) => {
        const result = await context.integrations.startSetup({
          ...input,
          userId: context.ownerUserId,
        });
        if (result instanceof Error) return integrationError(result);
        return result;
      }),
    setup: os.integrations.setup
      .use(loadIntegrationOwner)
      .handler(async ({ context, input }) => {
        const result = await context.integrations.setup({
          ...input,
          userId: context.ownerUserId,
        });
        if (result instanceof Error) return integrationError(result);
        return result;
      }),
    cancelSetup: os.integrations.cancelSetup
      .use(loadIntegrationOwner)
      .handler(async ({ context, input }) => {
        const result = await context.integrations.cancelSetup({
          ...input,
          userId: context.ownerUserId,
        });
        if (result instanceof Error) return integrationError(result);
      }),
    submitSetup: os.integrations.submitSetup
      .use(loadIntegrationUser)
      .handler(async ({ context, input }) => {
        const result = await context.integrations.submitSetup({
          ...input,
          userId: context.ownerUserId,
        });
        if (result instanceof Error) return integrationError(result);
        return result;
      }),
    registerOpenAPI: os.integrations.registerOpenAPI
      .use(loadIntegrationUser)
      .handler(async ({ context, input }) => {
        const result = await context.integrations.registerOpenAPI({
          ...input,
          userId: context.ownerUserId,
        });
        if (result instanceof Error) return integrationError(result);
      }),
    registerMcp: os.integrations.registerMcp
      .use(loadIntegrationUser)
      .handler(async ({ context, input }) => {
        const result = await context.integrations.registerMcp({
          ...input,
          userId: context.ownerUserId,
        });
        if (result instanceof Error) return integrationError(result);
      }),
    connections: os.integrations.connections
      .use(loadIntegrationUser)
      .handler(async ({ context }) => {
        const result = await context.integrations.connections(
          context.ownerUserId,
        );
        if (result instanceof Error) return integrationError(result);
        return result;
      }),
    search: os.integrations.search
      .use(loadRuntime)
      .handler(async ({ context, input, signal }) => {
        const result = await context.integrations.search({
          ...input,
          userId: context.ownerUserId,
          signal,
        });
        if (result instanceof Error) return integrationError(result);
        return result;
      }),
    describe: os.integrations.describe
      .use(loadRuntime)
      .handler(async ({ context, input, signal }) => {
        const result = await context.integrations.describe({
          ...input,
          userId: context.ownerUserId,
          signal,
        });
        if (result instanceof Error) return integrationError(result);
        return result;
      }),
    invoke: os.integrations.invoke
      .use(loadRuntime)
      .handler(async ({ context, input, signal }) => {
        const result = await context.integrations.invoke({
          ...input,
          userId: context.ownerUserId,
          signal,
        });
        if (result instanceof Error) return integrationError(result);
        return result;
      }),
  }),
  server: os.server.router({
    info: getServerInfo,
  }),
  auth: os.auth.router({
    start: startDesktopSignIn,
    exchange: exchangeDesktopAuthCode,
    session: getAuthSession,
  }),
  workspace: os.workspace.router({
    status: os.workspace.status
      .use(loadSession)
      .handler(async ({ context }) => {
        if (context.session === undefined)
          throw new ORPCError("UNAUTHORIZED", { message: "Sign in required" });
        const status = await context.workspace.getStatus(
          context.session.user.id,
        );
        if (status instanceof Error) throw internalError(status);
        return status;
      }),
    ensure: ensureWorkspace,
    rotateRuntimeToken: os.workspace.rotateRuntimeToken
      .use(loadSession)
      .handler(async ({ context }) => {
        if (context.session === undefined)
          throw new ORPCError("UNAUTHORIZED", { message: "Sign in required" });
        const workspace = await context.workspace.rotateRuntimeToken(
          context.session.user.id,
        );
        if (workspace instanceof Error) throw internalError(workspace);
        return {
          id: workspace.id,
          createdAt: workspace.createdAt.toISOString(),
        };
      }),
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
