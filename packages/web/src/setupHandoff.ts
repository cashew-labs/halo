import * as errore from "errore";
import type { HostApi } from "./HostApi.js";

type SetupApi = NonNullable<HostApi["integrationSetup"]>;
type HandoffStatus = "none" | "redeemed" | "failed";

export class SetupUnavailableError extends errore.createTaggedError({
  name: "SetupUnavailableError",
  message: "The connection setup is unavailable after a $handoff handoff",
}) {}

// Reads the setup after redeeming Halo's single-use handoff, whose cookie the
// read needs. The handoff is redeemed once, even when the setup is read again.
export function setupReader(input: {
  setupId: string;
  handoff: string | undefined;
  api: Pick<SetupApi, "read" | "redeemHandoff">;
}) {
  let redeemed: Promise<HandoffStatus> | undefined;
  return async () => {
    redeemed ??= redeemSetupHandoff(input);
    const handoff = await redeemed;
    const setup = await input.api.read(input.setupId);
    if (setup instanceof Error)
      return new SetupUnavailableError({ handoff, cause: setup });
    return setup;
  };
}

async function redeemSetupHandoff(input: {
  setupId: string;
  handoff: string | undefined;
  api: Pick<SetupApi, "redeemHandoff">;
}): Promise<HandoffStatus> {
  if (input.handoff === undefined) return "none";
  // Remove the used handoff so a reload or copied URL does not carry it.
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
  const redeemed = await input.api.redeemHandoff({
    setupId: input.setupId,
    handoff: input.handoff,
  });
  return redeemed instanceof Error ? "failed" : "redeemed";
}
