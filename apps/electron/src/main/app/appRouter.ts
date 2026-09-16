import { implement } from "@orpc/server";
import { appControlContract } from "@get-halo/app-control";
import type { AppControlService } from "./AppControlService.js";

type AppRouterContext = {
  appControl: AppControlService;
};

const os = implement(appControlContract).$context<AppRouterContext>();

export const appRouter = os.router({
  exec: os.exec.handler(async ({ context, input, errors }) => {
    const result = await context.appControl.exec(input.source);
    if (result instanceof Error)
      throw errors.BAD_REQUEST({
        message: result.message,
        data: { message: result.message },
      });
    return result;
  }),
  snapshot: os.snapshot.handler(async ({ context, errors }) => {
    const result = await context.appControl.snapshot();
    if (result instanceof Error)
      throw errors.BAD_REQUEST({
        message: result.message,
        data: { message: result.message },
      });
    return result;
  }),
  screenshot: os.screenshot.handler(async ({ context, errors }) => {
    const result = await context.appControl.screenshot();
    if (result instanceof Error)
      throw errors.BAD_REQUEST({
        message: result.message,
        data: { message: result.message },
      });
    return result;
  }),
});
