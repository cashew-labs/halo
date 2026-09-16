import { implement } from "@orpc/server";
import { contract } from "@get-halo/client";
import { orpcErrors } from "../orpcErrors.js";
import type { WorkspaceService } from "../workspace/WorkspaceService.js";
import { BrowserError } from "./BrowserPage.js";
import type { BrowserService } from "./BrowserService.js";
import type { AppControlService } from "../app/AppControlService.js";

export type BrowserRouterContext = {
  browsers: BrowserService;
  appControl: AppControlService;
  workspace: WorkspaceService;
  browserControlAllowed: boolean;
};

const os = implement(contract)
  .$context<BrowserRouterContext>()
  .use(async ({ context, next }) => {
    if (!context.browserControlAllowed)
      throw orpcErrors.badRequest(
        new BrowserError({
          detail: "Browser control requires the Halo CLI connection",
        }),
      );
    const workspace = context.workspace.getWorkspace();
    return await next({ context: { workspaceRoot: workspace.workspaceRoot } });
  });

export const browserRouter = os.browser.router({
  open: os.browser.open.handler(async ({ context, input }) => {
    const result = await context.browsers.open(input.url);
    if (result instanceof Error) throw orpcErrors.badRequest(result);
    return result;
  }),
  list: os.browser.list.handler(({ context }) => context.browsers.list()),
  exec: os.browser.exec.handler(async ({ context, input }) => {
    const result = await context.browsers.exec(input.id, input.source);
    if (result instanceof Error) throw orpcErrors.badRequest(result);
    return result;
  }),
  snapshot: os.browser.snapshot.handler(async ({ context, input }) => {
    const result = await context.browsers.snapshot(input.id);
    if (result instanceof Error) throw orpcErrors.badRequest(result);
    return result;
  }),
  screenshot: os.browser.screenshot.handler(async ({ context, input }) => {
    const result = await context.browsers.screenshot(
      input.id,
      context.workspaceRoot,
    );
    if (result instanceof Error) throw orpcErrors.badRequest(result);
    return result;
  }),
  close: os.browser.close.handler(async ({ context, input }) => {
    const result = await context.browsers.close(input.id);
    if (result instanceof Error) throw orpcErrors.badRequest(result);
    return result;
  }),
});

export const appRouter = os.app.router({
  exec: os.app.exec.handler(async ({ context, input }) => {
    const result = await context.appControl.exec(input.source);
    if (result instanceof Error) throw orpcErrors.badRequest(result);
    return result;
  }),
  snapshot: os.app.snapshot.handler(async ({ context }) => {
    const result = await context.appControl.snapshot();
    if (result instanceof Error) throw orpcErrors.badRequest(result);
    return result;
  }),
  screenshot: os.app.screenshot.handler(async ({ context }) => {
    const result = await context.appControl.screenshot(context.workspaceRoot);
    if (result instanceof Error) throw orpcErrors.badRequest(result);
    return result;
  }),
});
