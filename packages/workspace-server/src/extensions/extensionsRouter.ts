import { implement, os as baseOs, type } from "@orpc/server";
import { contract } from "@get-halo/client";
import { orpcErrors } from "../orpcErrors.js";
import type { ExtensionHost } from "./ExtensionHost.js";
import type { ToolRuntime } from "../agent/runtime/ToolRuntime.js";
import { authorizeExtensionTool } from "./extensionToolPolicy.js";
import * as errore from "errore";

class SharedAppToolDeniedError extends errore.createTaggedError({
  name: "SharedAppToolDeniedError",
  message: "Shared apps cannot access ordinary workspace tools",
}) {}

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
  watch: os.watch.handler(async function* ({ context, signal }) {
    for await (const snapshot of context.extensions.watch(signal)) {
      if (snapshot instanceof Error) throw orpcErrors.badRequest(snapshot);
      yield snapshot;
    }
  }),
  reload: os.reload.handler(
    async ({ context }) => await context.extensions.reload(),
  ),
  restart: os.restart.handler(async ({ context, input }) => {
    const restarted = await context.extensions.restart(input.id);
    if (restarted instanceof Error) return orpcErrors.badRequest(restarted);
  }),
  snapshot: os.snapshot.handler(async ({ context, input }) => {
    const snapshot = await context.extensions.snapshotProject(input.id);
    if (snapshot instanceof Error) return orpcErrors.badRequest(snapshot);
    return snapshot;
  }),
  install: os.install.handler(async ({ context, input }) => {
    const installed = await context.extensions.installProject({
      extensionId: input.id,
      artifact: input.artifact,
      installId: input.installId,
    });
    if (installed instanceof Error) return orpcErrors.badRequest(installed);
  }),
  freeze: os.freeze.handler(async ({ context, input }) => {
    const frozen = await context.extensions.freezeForPublication({
      extensionId: input.id,
      appId: input.appId,
    });
    if (frozen instanceof Error) return orpcErrors.badRequest(frozen);
  }),
  release: os.release.handler(async ({ context, input }) => {
    const released = await context.extensions.releasePublication({
      extensionId: input.id,
      appId: input.appId,
    });
    if (released instanceof Error) return orpcErrors.badRequest(released);
  }),
  completePublication: os.completePublication.handler(
    async ({ context, input }) => {
      const completed = await context.extensions.completePublication({
        extensionId: input.id,
        appId: input.appId,
        url: input.url,
        displayName: input.displayName,
      });
      if (completed instanceof Error) return orpcErrors.badRequest(completed);
    },
  ),
  readSource: os.readSource.handler(async ({ context, input }) => {
    const source = await context.extensions.readSource({
      extensionId: input.id,
      name: input.name,
    });
    if (source instanceof Error) return orpcErrors.badRequest(source);
    return source;
  }),
  writeSource: os.writeSource.handler(async ({ context, input }) => {
    const written = await context.extensions.writeSource({
      extensionId: input.id,
      name: input.name,
      contents: input.contents,
    });
    if (written instanceof Error) return orpcErrors.badRequest(written);
  }),
  execSource: os.execSource.handler(async ({ context, input }) => {
    const executed = await context.extensions.executeProject({
      extensionId: input.id,
      command: input.command,
    });
    if (executed instanceof Error) return orpcErrors.badRequest(executed);
    return executed;
  }),
});

const toolOs = baseOs.$context<{
  toolRuntime: ToolRuntime;
  sharedApp: boolean;
}>();
export const extensionToolRouter = {
  invoke: toolOs
    .input(type<{ path: string; input: unknown }>())
    .handler(async ({ input, context, signal }) => {
      // Shared app authority is supplied by the app service, never the owner's
      // ordinary tool runtime. Until that bridge is installed, deny every call.
      if (context.sharedApp)
        throw orpcErrors.badRequest(new SharedAppToolDeniedError());
      const denied = authorizeExtensionTool(input.path);
      if (denied instanceof Error) throw orpcErrors.badRequest(denied);
      const result = await context.toolRuntime.invokePath({
        path: input.path,
        args: input.input,
        signal,
      });
      if (result instanceof Error) throw orpcErrors.badRequest(result);
      return result;
    }),
};
