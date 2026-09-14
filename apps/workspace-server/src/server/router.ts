import {
  browserRouter,
  appRouter,
  type BrowserRouterContext,
} from "../browser/browserRouter.js";
import { contract, haloProtocolVersion } from "@get-halo/shared/contract";
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
  testingRouter,
  type TestingRouterContext,
} from "../testing/testingRouter.js";

export type HaloContext = BrowserRouterContext &
  WorkspaceRouterContext &
  ExtensionsRouterContext &
  SessionsRouterContext &
  TestingRouterContext;

const server = implement(contract.server);

const serverRouter = server.router({
  info: server.info.handler(() => ({ protocolVersion: haloProtocolVersion })),
});

export const haloRpcRouter = {
  server: serverRouter,
  browser: browserRouter,
  app: appRouter,
  workspace: workspaceRouter,
  sessions: sessionsRouter,
  extensions: extensionsRouter,
  testHarness: testingRouter,
};
