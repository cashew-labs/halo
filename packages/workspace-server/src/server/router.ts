import {
  automationsRouter,
  type AutomationsRouterContext,
} from "../automations/automationsRouter.js";
import { watchWorkspace } from "./watchWorkspace.js";
import { syncRouter, type SyncRouterContext } from "../database/syncRouter.js";
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
  threadRouter,
  type ThreadRouterContext,
} from "../sessions/threadRouter.js";
import {
  workspaceRouter,
  type WorkspaceRouterContext,
} from "../workspace/workspaceRouter.js";
import {
  testApiRouter,
  type TestApiRouterContext,
} from "../testing/testApiRouter.js";

export type HaloContext = RequestHeadersHandlerPluginContext &
  SyncRouterContext &
  HotkeysRouterContext &
  AutomationsRouterContext &
  BrowserRouterContext &
  TracesRouterContext &
  WorkspaceRouterContext &
  ExtensionsRouterContext &
  ThreadRouterContext &
  TestApiRouterContext & { build?: { version: string; revision: string } };

const server = implement(contract.server).$context<HaloContext>();

const serverRouter = server.router({
  info: server.info.handler(({ context }) => ({
    protocolVersion: haloProtocolVersion,
    supportedProtocols: haloSupportedProtocols,
    build: context.build,
  })),
  watch: server.watch.handler(({ context, input, signal }) =>
    watchWorkspace({
      context,
      includeAutomations: input?.includeAutomations,
      includeLegacyState: input?.includeLegacyState,
      signal,
    }),
  ),
});

export const haloRpcRouter = {
  sync: syncRouter,
  server: serverRouter,
  hotkeys: hotkeysRouter,
  automations: automationsRouter,
  browser: browserRouter,
  workspace: workspaceRouter,
  thread: threadRouter,
  traces: tracesRouter,
  extensions: extensionsRouter,
  testApi: testApiRouter,
};
