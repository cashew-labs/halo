import { implement, ORPCError } from "@orpc/server";
import type { RouterContractClient } from "@orpc/contract";
import { contract } from "@get-halo/client";
import * as errore from "errore";

class RemoteAppsUnavailableError extends errore.createTaggedError({
  name: "RemoteAppsUnavailableError",
  message: "Published apps need a Halo account workspace",
}) {}

/** Control-plane app operations, authenticated as this workspace's owner. */
export type RemoteApps = RouterContractClient<typeof contract.apps>;

export type AppsRouterContext = { remoteApps: RemoteApps | undefined };
const os = implement(contract.apps).$context<AppsRouterContext>();

// Forwards the control plane's validation messages; other failures stay opaque.
async function forward<T>(
  context: AppsRouterContext,
  call: (apps: RemoteApps) => Promise<T>,
) {
  if (context.remoteApps === undefined)
    throw new ORPCError("BAD_REQUEST", {
      message: new RemoteAppsUnavailableError().message,
    });
  return await call(context.remoteApps).catch((cause: unknown) => {
    if (cause instanceof ORPCError && cause.code === "BAD_REQUEST")
      throw new ORPCError("BAD_REQUEST", { message: cause.message });
    throw cause;
  });
}

export const appsRouter = os.router({
  list: os.list.handler(
    async ({ context }) =>
      await forward(context, async (apps) => await apps.list()),
  ),
  publish: os.publish.handler(
    async ({ context, input }) =>
      await forward(context, async (apps) => await apps.publish(input)),
  ),
  update: os.update.handler(
    async ({ context, input }) =>
      await forward(context, async (apps) => await apps.update(input)),
  ),
  cancel: os.cancel.handler(
    async ({ context, input }) =>
      await forward(context, async (apps) => await apps.cancel(input)),
  ),
  bindActions: os.bindActions.handler(
    async ({ context, input }) =>
      await forward(context, async (apps) => await apps.bindActions(input)),
  ),
  readSource: os.readSource.handler(
    async ({ context, input }) =>
      await forward(context, async (apps) => await apps.readSource(input)),
  ),
  writeSource: os.writeSource.handler(
    async ({ context, input }) =>
      await forward(context, async (apps) => await apps.writeSource(input)),
  ),
  execSource: os.execSource.handler(
    async ({ context, input }) =>
      await forward(context, async (apps) => await apps.execSource(input)),
  ),
  publishTemplate: os.publishTemplate.handler(
    async ({ context, input }) =>
      await forward(context, async (apps) => await apps.publishTemplate(input)),
  ),
  restart: os.restart.handler(
    async ({ context, input }) =>
      await forward(context, async (apps) => await apps.restart(input)),
  ),
});
