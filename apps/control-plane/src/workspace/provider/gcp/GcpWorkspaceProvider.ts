import * as errore from "errore";
import { provisionGcpWorkspace } from "./gcpProvisioning.js";
import type {
  WorkspaceProviderApi,
  WorkspaceProviderConnection,
  WorkspaceProviderInput,
  WorkspaceProviderAssignment,
} from "../WorkspaceProviderApi.js";

class GcpAppVmUnsupportedError extends errore.createTaggedError({
  name: "GcpAppVmUnsupportedError",
  message: "Shared apps require the exe.dev provider's sandboxed app VMs",
}) {}

export class GcpWorkspaceProvider implements WorkspaceProviderApi {
  // GCP has no explicit pause/resume capability in Halo yet.
  readonly pause = undefined;
  readonly resume = undefined;

  private readonly projectId: string;
  private readonly zone: string;
  private readonly instanceTemplate: string;

  constructor(ctx: {
    projectId: string;
    zone: string;
    instanceTemplate: string;
  }) {
    this.projectId = ctx.projectId;
    this.zone = ctx.zone;
    this.instanceTemplate = ctx.instanceTemplate;
  }

  async ensure(input: WorkspaceProviderAssignment) {
    if (input.sharedApp !== undefined) return new GcpAppVmUnsupportedError();
    return await provisionGcpWorkspace({
      ...input,
      config: {
        projectId: this.projectId,
        zone: this.zone,
        instanceTemplate: this.instanceTemplate,
      },
    });
  }

  async getConnection(input: WorkspaceProviderInput) {
    const instanceName = `halo-${input.workspaceId}`;
    return {
      origin: `http://${instanceName}.${this.zone}.c.${this.projectId}.internal:8788`,
      authorization: { type: "googleIdentity" },
    } satisfies WorkspaceProviderConnection;
  }
}
