import type { ControlPlaneSession } from "@get-halo/shared/controlPlaneContract";
import type { ReleaseChannel } from "@get-halo/config/releaseChannel";

/**
 * Decides whether the menu offers "Use Staging". The control plane marks
 * staging testers on their session, so the list stays out of the app.
 */
export class StagingToggle {
  private stagingAccess = false;
  private readonly onChange: () => void;

  constructor(ctx: { onChange: () => void }) {
    this.onChange = ctx.onChange;
  }

  /** Records the latest session lookup; errors keep the current answer. */
  observe(session: ControlPlaneSession | Error | undefined) {
    if (session instanceof Error) return;
    const stagingAccess = session?.stagingAccess === true;
    if (stagingAccess === this.stagingAccess) return;
    this.stagingAccess = stagingAccess;
    this.onChange();
  }

  // A staging install always offers the way back to production.
  isOffered(releaseChannel: ReleaseChannel) {
    return releaseChannel === "staging" || this.stagingAccess;
  }
}
