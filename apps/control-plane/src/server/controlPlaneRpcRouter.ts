import type { WorkspaceUpdates } from "../workspace/WorkspaceUpdates.js";
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
import {
  setupBrowserCookie,
  setupBrowserCookies,
} from "../integrations/setupBrowserCookie.js";
import { isAppRequestError, type AppService } from "../apps/AppService.js";

import {
  MarketingAdminRequiredError,
  MarketingLinkConflictError,
  MarketingLinkNotFoundError,
  type MarketingLinks,
} from "../marketing/MarketingLinks.js";

export type ControlPlaneContext = RequestHeadersHandlerPluginContext &
  ResponseHeadersHandlerPluginContext & {
    build?: { version: string; revision: string };
    publicOrigin: string;
    auth: AuthService;
    workspace: WorkspaceService;
    workspaceUpdates: WorkspaceUpdates;
    integrations?: IntegrationService;
    apps: AppService;
    marketing: MarketingLinks;
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

// Signed-in people only. Desktop bearer sessions are not ambient.
async function integrationUser(context: ControlPlaneContext) {
  const headers = context.reqHeaders ?? new Headers();
  const origin = headers.get("origin");
  // Browser cookies require same-origin requests. Desktop bearer sessions are not ambient.
  if (origin !== null && origin !== context.publicOrigin)
    throw new ORPCError("FORBIDDEN");
  if (origin === null && !headers.get("authorization")?.startsWith("Bearer "))
    throw new ORPCError("FORBIDDEN"); // coverage-exempt: moved unchanged from loadIntegrationUser
  const session = await context.auth.getSession(headers);
  if (session instanceof Error) throw internalError(session);
  if (session === undefined) throw new ORPCError("UNAUTHORIZED");
  if (context.integrations === undefined)
    throw new ORPCError("SERVICE_UNAVAILABLE"); // coverage-exempt: moved unchanged from loadIntegrationUser
  return {
    ownerUserId: session.user.id,
    ownerLabel: session.user.email,
    integrations: context.integrations,
  };
}

// Signed-in people or the owner's workspace runtime.
async function integrationOwner(context: ControlPlaneContext) {
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
    throw new ORPCError("SERVICE_UNAVAILABLE"); // coverage-exempt: moved unchanged from loadIntegrationOwner
  if (
    session !== undefined &&
    headers.get("origin") !== null &&
    headers.get("origin") !== context.publicOrigin
  )
    throw new ORPCError("FORBIDDEN"); // coverage-exempt: moved unchanged from loadIntegrationOwner
  return {
    ownerUserId: session?.user.id ?? runtime!.ownerUserId,
    integrations: context.integrations,
  };
}

// The signed-in owner, or the owner's own workspace runtime acting for its agent.
// App VM tokens never authenticate here.
async function appOwner(context: ControlPlaneContext) {
  const headers = context.reqHeaders ?? new Headers();
  const origin = headers.get("origin");
  if (origin !== null && origin !== context.publicOrigin)
    throw new ORPCError("FORBIDDEN");
  if (origin === null && !headers.get("authorization")?.startsWith("Bearer "))
    throw new ORPCError("FORBIDDEN");
  const session = await context.auth.getSession(headers);
  if (session instanceof Error) throw internalError(session);
  if (session !== undefined)
    return { ownerUserId: session.user.id, ownerEmail: session.user.email };
  const runtime = await context.workspace.authenticateRuntimeOwner(headers);
  if (runtime instanceof WorkspaceAuthenticationRequiredError)
    throw new ORPCError("UNAUTHORIZED");
  if (runtime instanceof Error) throw internalError(runtime);
  const email = await context.auth.findUserEmail(runtime.ownerUserId);
  if (email instanceof Error) throw internalError(email);
  if (email === undefined) throw new ORPCError("UNAUTHORIZED");
  return { ownerUserId: runtime.ownerUserId, ownerEmail: email };
}

function appError(result: Error): never {
  if (isAppRequestError(result)) throw badRequest(result);
  throw internalError(result);
}

function marketingResult<T>(result: T | Error): T {
  if (result instanceof MarketingAdminRequiredError)
    throw new ORPCError("FORBIDDEN", { message: result.message });
  if (result instanceof MarketingLinkConflictError)
    throw new ORPCError("CONFLICT", { message: result.message });
  if (result instanceof MarketingLinkNotFoundError)
    throw new ORPCError("NOT_FOUND", { message: result.message });
  if (result instanceof Error) throw internalError(result); // coverage-exempt: Database outage translation at the transport edge; real database failures are covered at the service boundary.
  return result;
}

// The browser that redeemed a setup's handoff acts for the setup owner, without
// a Halo session.
async function setupBrowserOwner(
  context: ControlPlaneContext,
  setupId: string,
) {
  const headers = context.reqHeaders ?? new Headers();
  const browser = setupBrowserCookies(headers, context.publicOrigin).get(
    setupId,
  );
  if (browser === undefined || context.integrations === undefined) return;
  if (headers.get("origin") !== context.publicOrigin)
    throw new ORPCError("FORBIDDEN");
  const owner = await context.integrations.setupOwnerForBrowser({
    setupId,
    browser,
  });
  if (owner instanceof Error) throw internalError(owner);
  if (owner === undefined) return;
  return { ownerUserId: owner, integrations: context.integrations };
}

const loadIntegrationUser = implementer.middleware(
  async ({ context, next }) =>
    await next({ context: await integrationUser(context) }),
);

const loadIntegrationOwner = implementer.middleware(
  async ({ context, next }) =>
    await next({ context: await integrationOwner(context) }),
);

const loadSetupOwner = implementer.middleware(
  async ({ context, next }, input: { setupId: string }) =>
    await next({
      context:
        (await setupBrowserOwner(context, input.setupId)) ??
        (await integrationOwner(context)),
    }),
);

const loadSetupUser = implementer.middleware(
  async ({ context, next }, input: { setupId: string }) =>
    await next({
      context:
        (await setupBrowserOwner(context, input.setupId)) ??
        (await integrationUser(context)),
    }),
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
      .use(loadSetupOwner)
      .handler(async ({ context, input }) => {
        const result = await context.integrations.setup({
          ...input,
          userId: context.ownerUserId,
        });
        if (result instanceof Error) return integrationError(result);
        return result;
      }),
    cancelSetup: os.integrations.cancelSetup
      .use(loadSetupOwner)
      .handler(async ({ context, input }) => {
        const result = await context.integrations.cancelSetup({
          ...input,
          userId: context.ownerUserId,
        });
        if (result instanceof Error) return integrationError(result);
      }),
    submitSetup: os.integrations.submitSetup
      .use(loadSetupUser)
      .handler(async ({ context, input }) => {
        const result = await context.integrations.submitSetup({
          ...input,
          userId: context.ownerUserId,
        });
        if (result instanceof Error) return integrationError(result);
        return result;
      }),
    createSetupHandoff: os.integrations.createSetupHandoff
      .use(loadIntegrationUser)
      .handler(async ({ context, input }) => {
        const result = await context.integrations.createSetupHandoff({
          ...input,
          userId: context.ownerUserId,
          ownerLabel: context.ownerLabel,
        });
        if (result instanceof Error) return integrationError(result);
        return result;
      }),
    redeemSetupHandoff: os.integrations.redeemSetupHandoff.handler(
      async ({ context, input }) => {
        // The cookie is set only for the page that Halo opened on this origin.
        if (context.reqHeaders?.get("origin") !== context.publicOrigin)
          throw new ORPCError("FORBIDDEN");
        if (context.integrations === undefined)
          throw new ORPCError("SERVICE_UNAVAILABLE"); // coverage-exempt: integrations are configured in every tested deployment
        const result = await context.integrations.redeemSetupHandoff(input);
        if (result instanceof Error) return integrationError(result);
        context.resHeaders?.append(
          "set-cookie",
          setupBrowserCookie({
            setupId: input.setupId,
            browser: result.browser,
            publicOrigin: context.publicOrigin,
          }),
        );
      },
    ),
    registerOpenAPI: os.integrations.registerOpenAPI
      .use(loadIntegrationOwner)
      .handler(async ({ context, input }) => {
        const result = await context.integrations.registerApi({
          ...input,
          userId: context.ownerUserId,
        });
        if (result instanceof Error) return integrationError(result);
      }),
    registerMcp: os.integrations.registerMcp
      .use(loadIntegrationOwner)
      .handler(async ({ context, input }) => {
        const result = await context.integrations.registerMcp({
          ...input,
          userId: context.ownerUserId,
        });
        if (result instanceof Error) return integrationError(result);
      }),
    // Agents list connections to find the one a person names.
    connections: os.integrations.connections
      .use(loadIntegrationOwner)
      .handler(async ({ context }) => {
        const result = await context.integrations.connections(
          context.ownerUserId,
        );
        if (result instanceof Error) return integrationError(result);
        return result;
      }),
    // The workspace asks the person to approve removal before calling this.
    removeConnection: os.integrations.removeConnection
      .use(loadIntegrationOwner)
      .handler(async ({ context, input }) => {
        const result = await context.integrations.removeConnection({
          ...input,
          userId: context.ownerUserId,
        });
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
  marketing: os.marketing.router({
    create: os.marketing.create.handler(async ({ context, input }) => {
      const owner = await appOwner(context);
      return marketingResult(
        await context.marketing.create({
          ...input,
          ownerUserId: owner.ownerUserId,
        }),
      );
    }),
    list: os.marketing.list.handler(async ({ context }) => {
      const owner = await appOwner(context);
      return marketingResult(await context.marketing.list(owner.ownerUserId));
    }),
    update: os.marketing.update.handler(async ({ context, input }) => {
      const owner = await appOwner(context);
      return marketingResult(
        await context.marketing.update({
          ...input,
          ownerUserId: owner.ownerUserId,
        }),
      );
    }),
    remove: os.marketing.remove.handler(async ({ context, input }) => {
      const owner = await appOwner(context);
      return marketingResult(
        await context.marketing.remove({
          ...input,
          ownerUserId: owner.ownerUserId,
        }),
      );
    }),
  }),
  apps: os.apps.router({
    publisher: os.apps.publisher.handler(async ({ context }) => {
      const owner = await appOwner(context);
      const result = await context.apps.publisher(owner);
      if (result instanceof Error) return appError(result);
      return result;
    }),
    checkPublisherHandle: os.apps.checkPublisherHandle.handler(
      async ({ context, input }) => {
        const owner = await appOwner(context);
        const result = await context.apps.checkPublisherHandle({
          ...owner,
          ...input,
        });
        if (result instanceof Error) return appError(result);
        return result;
      },
    ),
    renamePublisher: os.apps.renamePublisher.handler(
      async ({ context, input }) => {
        const owner = await appOwner(context);
        const result = await context.apps.renamePublisher({
          ...owner,
          ...input,
        });
        if (result instanceof Error) return appError(result);
        return result;
      },
    ),
    list: os.apps.list.handler(async ({ context }) => {
      const owner = await appOwner(context);
      const apps = await context.apps.list(owner.ownerUserId);
      if (apps instanceof Error) return appError(apps);
      return apps;
    }),
    publish: os.apps.publish.handler(async ({ context, input }) => {
      const owner = await appOwner(context);
      const published = await context.apps.publish({ ...owner, ...input });
      if (published instanceof Error) return appError(published);
      return published;
    }),
    update: os.apps.update.handler(async ({ context, input }) => {
      const owner = await appOwner(context);
      const updated = await context.apps.update({ ...owner, ...input });
      if (updated instanceof Error) return appError(updated);
      return updated;
    }),
    cancel: os.apps.cancel.handler(async ({ context, input }) => {
      const owner = await appOwner(context);
      const cancelled = await context.apps.cancel({ ...owner, ...input });
      if (cancelled instanceof Error) return appError(cancelled);
    }),
    remove: os.apps.remove.handler(async ({ context, input }) => {
      const owner = await appOwner(context);
      const deleted = await context.apps.remove({ ...owner, ...input });
      if (deleted instanceof Error) return appError(deleted);
    }),
    bindActions: os.apps.bindActions.handler(async ({ context, input }) => {
      const owner = await appOwner(context);
      const bound = await context.apps.bindActions({ ...owner, ...input });
      if (bound instanceof Error) return appError(bound);
      return bound;
    }),
    readSource: os.apps.readSource.handler(async ({ context, input }) => {
      const owner = await appOwner(context);
      const source = await context.apps.readSource({ ...owner, ...input });
      if (source instanceof Error) return appError(source);
      return source;
    }),
    writeSource: os.apps.writeSource.handler(async ({ context, input }) => {
      const owner = await appOwner(context);
      const written = await context.apps.writeSource({ ...owner, ...input });
      if (written instanceof Error) return appError(written);
    }),
    execSource: os.apps.execSource.handler(async ({ context, input }) => {
      const owner = await appOwner(context);
      const executed = await context.apps.execSource({ ...owner, ...input });
      if (executed instanceof Error) return appError(executed);
      return executed;
    }),
    publishTemplate: os.apps.publishTemplate.handler(
      async ({ context, input }) => {
        const owner = await appOwner(context);
        const published = await context.apps.publishTemplate({
          ownerUserId: owner.ownerUserId,
          ...input,
        });
        if (published instanceof Error) return appError(published);
        return published;
      },
    ),
    restart: os.apps.restart.handler(async ({ context, input }) => {
      const owner = await appOwner(context);
      const restarted = await context.apps.restart({ ...owner, ...input });
      if (restarted instanceof Error) return appError(restarted);
    }),
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
        const update = await context.workspaceUpdates.status(
          context.session.user.id,
        );
        if (update instanceof Error) throw internalError(update);
        return { ...status, update };
      }),
    cancelUpgrade: os.workspace.cancelUpgrade
      .use(loadSession)
      .handler(async ({ context }) => {
        if (context.session === undefined) throw new ORPCError("UNAUTHORIZED");
        const result = await context.workspaceUpdates.cancel(
          context.session.user.id,
        );
        if (result instanceof Error) throw badRequest(result);
      }),
    upgrade: os.workspace.upgrade
      .use(loadSession)
      .handler(async ({ context, input }) => {
        if (context.session === undefined) throw new ORPCError("UNAUTHORIZED");
        const result = await context.workspaceUpdates.request(
          context.session.user.id,
          input.force,
        );
        if (result instanceof Error) throw badRequest(result);
        return result;
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
    stagingAccess: session.stagingAccess,
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
