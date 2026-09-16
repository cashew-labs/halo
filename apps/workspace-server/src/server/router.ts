import {
  browserRouter,
  type BrowserRouterContext,
} from "../browser/browserRouter.js";
import { contract, haloProtocolVersion } from "@get-halo/client";
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
  testingRouter,
  type TestingRouterContext,
} from "../testing/testingRouter.js";

export type HaloContext = BrowserRouterContext &
  TracesRouterContext &
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
  workspace: workspaceRouter,
  sessions: sessionsRouter,
  traces: tracesRouter,
  extensions: extensionsRouter,
  testHarness: testingRouter,
};
