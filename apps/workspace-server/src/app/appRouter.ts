import { implement } from "@orpc/server";
import { appControlContract } from "@get-halo/app-control";
import { orpcErrors } from "../orpcErrors.js";
import { BrowserError } from "../browser/BrowserPage.js";
import type { WorkspaceService } from "../workspace/WorkspaceService.js";
import type { AppControlService } from "./AppControlService.js";

export type AppRouterContext = {
  appControl: AppControlService;
  workspace: WorkspaceService;
  browserControlAllowed: boolean;
};

const os = implement(appControlContract)
  .$context<AppRouterContext>()
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

export const appRouter = os.router({
  exec: os.exec.handler(async ({ context, input }) => {
    const result = await context.appControl.exec(input.source);
    if (result instanceof Error) throw orpcErrors.badRequest(result);
    return result;
  }),
  snapshot: os.snapshot.handler(async ({ context }) => {
    const result = await context.appControl.snapshot();
    if (result instanceof Error) throw orpcErrors.badRequest(result);
    return result;
  }),
  screenshot: os.screenshot.handler(async ({ context }) => {
    const result = await context.appControl.screenshot(context.workspaceRoot);
    if (result instanceof Error) throw orpcErrors.badRequest(result);
    return result;
  }),
});
