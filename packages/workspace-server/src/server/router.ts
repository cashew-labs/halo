import {
  favoritesRouter,
  type FavoritesRouterContext,
} from "../favorites/favoritesRouter.js";
import type { WorkspaceMaintenance } from "./WorkspaceMaintenance.js";
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
  agentsRouter,
  type AgentsRouterContext,
} from "../agents/agentsRouter.js";
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
  appsRouter,
  type AppsRouterContext,
} from "../extensions/appsRouter.js";
import {
  threadRouter,
  type ThreadRouterContext,
} from "../threads/threadRouter.js";
import {
  workspaceRouter,
  type WorkspaceRouterContext,
} from "../workspace/workspaceRouter.js";
import {
  uploadsRouter,
  type UploadsRouterContext,
} from "../uploads/uploadsRouter.js";
import {
  testApiRouter,
  type TestApiRouterContext,
} from "../testing/testApiRouter.js";

export type HaloContext = RequestHeadersHandlerPluginContext &
  SyncRouterContext &
  FavoritesRouterContext &
  HotkeysRouterContext &
  AgentsRouterContext &
  AutomationsRouterContext &
  TracesRouterContext &
  WorkspaceRouterContext &
  UploadsRouterContext &
  ExtensionsRouterContext &
  AppsRouterContext &
  ThreadRouterContext &
  TestApiRouterContext & {
    maintenance: WorkspaceMaintenance;
    build?: { version: string; revision: string };
  };

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
  favorites: favoritesRouter,
  server: serverRouter,
  hotkeys: hotkeysRouter,
  agents: agentsRouter,
  automations: automationsRouter,
  workspace: workspaceRouter,
  uploads: uploadsRouter,
  thread: threadRouter,
  traces: tracesRouter,
  apps: appsRouter,
  extensions: extensionsRouter,
  testApi: testApiRouter,
};
