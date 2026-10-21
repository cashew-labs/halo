import * as errore from "errore";
import type {
  ControlPlaneWorkspaceStatus,
  WorkspaceUpgradeResult,
} from "./controlPlaneContract.js";

class WorkspaceUpdatePreparationError extends errore.createTaggedError({
  name: "WorkspaceUpdatePreparationError",
  message: "$message",
}) {}

/** Both desktop and browser updates must finish workspace maintenance first. */
export async function prepareWorkspaceUpdate(ctx: {
  request: (force: boolean) => Promise<WorkspaceUpgradeResult | Error>;
  cancel: () => Promise<void | Error>;
  status: () => Promise<ControlPlaneWorkspaceStatus | Error | undefined>;
  confirmInterruption: () => Promise<boolean>;
  timeoutMs?: number;
  pollMs?: number;
}) {
  const deadline = Date.now() + (ctx.timeoutMs ?? 20 * 60_000);
  let force = false;
  let result = await ctx.request(false);
  while (Date.now() < deadline) {
    if (result instanceof Error) return result;
    if (result.status === "current") return true;
    if (result.status === "busy") {
      if (!(await ctx.confirmInterruption())) {
        const cancelled = await ctx.cancel();
        return cancelled instanceof Error ? cancelled : false;
      }
      force = true;
      result = await ctx.request(true);
      continue;
    }
    await new Promise<void>((done) => setTimeout(done, ctx.pollMs ?? 1000));
    if (result.status === "checking") {
      result = await ctx.request(false);
      continue;
    }
    const status = await ctx.status();
    if (status instanceof Error) return status;
    if (status?.update?.state === "failed")
      return new WorkspaceUpdatePreparationError({
        message:
          status.update.error ??
          "Your workspace could not update. Try updating again.",
      });
    if (status?.update?.state === "current") return true;
    if (status?.update?.busy && status.update.state !== "upgrading" && !force) {
      result = { status: "busy" };
    }
  }
  const cancelled = await ctx.cancel();
  if (cancelled instanceof Error) return cancelled;
  return new WorkspaceUpdatePreparationError({
    message:
      "Your workspace is still updating. Wait for it to reconnect, then try updating Halo again.",
  });
}
