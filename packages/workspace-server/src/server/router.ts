import { watchWorkspace } from "./watchWorkspace.js";
import {
  hotkeysRouter,
  type HotkeysRouterContext,
} from "../hotkeys/hotkeysRouter.js";
import {
  browserRouter,
  type BrowserRouterContext,
} from "../browser/browserRouter.js";
import {
  contract,
  haloProtocolVersion,
  haloSupportedProtocols,
} from "@get-halo/client";
import type { RequestHeadersHandlerPluginContext } from "@orpc/server/plugins";
import { implement } from "@orpc/server";
import {
  tracesRouter,
  type TracesRouterContext,
} from "../traces/tracesRouter.js";
import {
  extensionsRouter,
  type ExtensionsRouterContext,
} from "../extensions/extensionsRouter.js";
import {
  sessionsRouter,
  type SessionsRouterContext,
} from "../sessions/sessionsRouter.js";
import {
  workspaceRouter,
  type WorkspaceRouterContext,
} from "../workspace/workspaceRouter.js";
import {
  testApiRouter,
  type TestApiRouterContext,
} from "../testing/testApiRouter.js";

export type HaloContext = RequestHeadersHandlerPluginContext &
  HotkeysRouterContext &
  BrowserRouterContext &
  TracesRouterContext &
  WorkspaceRouterContext &
  ExtensionsRouterContext &
  SessionsRouterContext &
  TestApiRouterContext & { build?: { version: string; revision: string } };

const server = implement(contract.server).$context<HaloContext>();

const serverRouter = server.router({
  info: server.info.handler(({ context }) => ({
    protocolVersion: haloProtocolVersion,
    supportedProtocols: haloSupportedProtocols,
    build: context.build,
  })),
  watch: server.watch.handler(({ context, signal }) =>
    watchWorkspace({ context, signal }),
  ),
});

export const haloRpcRouter = {
  server: serverRouter,
  hotkeys: hotkeysRouter,
  browser: browserRouter,
  workspace: workspaceRouter,
  sessions: sessionsRouter,
  traces: tracesRouter,
  extensions: extensionsRouter,
  testApi: testApiRouter,
};
