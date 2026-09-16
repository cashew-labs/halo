import { implement } from "@orpc/server";
import { contract } from "@get-halo/client";
import { orpcErrors } from "../orpcErrors.js";
import type { WorkspaceService } from "../workspace/WorkspaceService.js";
import { BrowserError } from "./BrowserPage.js";
import type { BrowserService } from "./BrowserService.js";

export type BrowserRouterContext = {
  browsers: BrowserService;
  workspace: WorkspaceService;
  browserControlAllowed: boolean;
};

const os = implement(contract.browser)
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

export const browserRouter = os.router({
  open: os.open.handler(async ({ context, input }) => {
    const result = await context.browsers.open(input.url);
    if (result instanceof Error) throw orpcErrors.badRequest(result);
    return result;
  }),
  list: os.list.handler(({ context }) => context.browsers.list()),
  exec: os.exec.handler(async ({ context, input }) => {
    const result = await context.browsers.exec(input.id, input.source);
    if (result instanceof Error) throw orpcErrors.badRequest(result);
    return result;
  }),
  snapshot: os.snapshot.handler(async ({ context, input }) => {
    const result = await context.browsers.snapshot(input.id);
    if (result instanceof Error) throw orpcErrors.badRequest(result);
    return result;
  }),
  screenshot: os.screenshot.handler(async ({ context, input }) => {
    const result = await context.browsers.screenshot(
      input.id,
      context.workspaceRoot,
    );
    if (result instanceof Error) throw orpcErrors.badRequest(result);
    return result;
  }),
  close: os.close.handler(async ({ context, input }) => {
    const result = await context.browsers.close(input.id);
    if (result instanceof Error) throw orpcErrors.badRequest(result);
    return result;
  }),
});
