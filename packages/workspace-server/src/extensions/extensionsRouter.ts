import { implement, os as baseOs, type } from "@orpc/server";
import { contract } from "@get-halo/client";
import { orpcErrors } from "../orpcErrors.js";
import type { ExtensionHost } from "./ExtensionHost.js";
import type { ToolRuntime } from "../agent/runtime/ToolRuntime.js";

export type ExtensionsRouterContext = {
  extensions: ExtensionHost;
};
const os = implement(contract.extensions).$context<ExtensionsRouterContext>();

export const extensionsRouter = os.router({
  list: os.list.handler(async ({ context }) => {
    const extensions = await context.extensions.list();
    if (extensions instanceof Error) return orpcErrors.badRequest(extensions);
    return extensions;
  }),
  reload: os.reload.handler(
    async ({ context }) => await context.extensions.reload(),
  ),
  restart: os.restart.handler(async ({ context, input }) => {
    const restarted = await context.extensions.restart(input.id);
    if (restarted instanceof Error) return orpcErrors.badRequest(restarted);
  }),
});

const toolOs = baseOs.$context<{ toolRuntime: ToolRuntime }>();
export const extensionToolRouter = {
  invoke: toolOs
    .input(type<{ path: string; input: unknown }>())
    .handler(async ({ input, context, signal }) => {
      const result = await context.toolRuntime.invokePath({
        path: input.path,
        args: input.input,
        signal,
      });
      if (result instanceof Error) throw orpcErrors.badRequest(result);
      return result;
    }),
};
