import {
  browserRouter,
  type BrowserRouterContext,
} from "../browser/browserRouter.js";
import { contract, haloProtocolVersion } from "@get-halo/client";
import { implement } from "@orpc/server";
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

export type HaloContext = BrowserRouterContext &
  WorkspaceRouterContext &
  ExtensionsRouterContext &
  SessionsRouterContext &
  TestApiRouterContext;

const server = implement(contract.server);

const serverRouter = server.router({
  info: server.info.handler(() => ({ protocolVersion: haloProtocolVersion })),
});

export const haloRpcRouter = {
  server: serverRouter,
  browser: browserRouter,
  workspace: workspaceRouter,
  sessions: sessionsRouter,
  extensions: extensionsRouter,
  testApi: testApiRouter,
};
