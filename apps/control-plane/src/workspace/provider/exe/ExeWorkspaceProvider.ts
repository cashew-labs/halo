import crypto from "node:crypto";
import timers from "node:timers/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import { ExeApi, ExeApiError } from "./ExeApi.js";
import type {
  WorkspaceProviderApi,
  WorkspaceProviderConnection,
  WorkspaceProviderInput,
  WorkspaceProviderAssignment,
} from "../WorkspaceProviderApi.js";

class ExeWorkspaceProviderError extends errore.createTaggedError({
  name: "ExeWorkspaceProviderError",
  message: "Exe workspace $workspaceId failed: $detail",
}) {}

const vmSchema = Type.Object({
  vm_name: Type.String(),
  status: Type.String(),
  // Verified on the real /exec ls response, including a newly cloned private VM.
  proxy_share: Type.String(),
});
const listSchema = Type.Object({ vms: Type.Array(vmSchema) });
// Verified on real /exec cp: it returns name, whereas new returns vm_name.
const cloneSchema = Type.Object({ name: Type.String() });

export class ExeWorkspaceProvider implements WorkspaceProviderApi {
  // Coalesce same-workspace provisioning within this control-plane instance.
  private readonly pendingEnsures = new Map<
    string,
    {
      ownerUserId: string;
      runtime: WorkspaceProviderAssignment["runtime"];
      operation: Promise<void | Error>;
    }
  >();
  private readonly api: ExeApi;
  private readonly templateVmName: string;
  private readonly gatewaySecret: string;

  constructor(ctx: {
    privateKeyPath: string;
    templateVmName: string;
    gatewaySecret: string;
  }) {
    this.api = new ExeApi({
      privateKeyPath: ctx.privateKeyPath,
    });
    this.templateVmName = ctx.templateVmName;
    this.gatewaySecret = ctx.gatewaySecret;
  }

  async ensure(input: WorkspaceProviderAssignment): Promise<void | Error> {
    const pending = this.pendingEnsures.get(input.workspaceId);
    if (pending !== undefined) {
      if (pending.ownerUserId !== input.ownerUserId)
        return new ExeWorkspaceProviderError({
          workspaceId: input.workspaceId,
          detail: "workspace is being assigned to another owner",
        });
      if (JSON.stringify(pending.runtime) !== JSON.stringify(input.runtime)) {
        const completed = await pending.operation;
        if (completed instanceof Error) return completed;
        return await this.ensure(input);
      }
      return await pending.operation;
    }
    const operation = this.ensureWorkspace(input);
    this.pendingEnsures.set(input.workspaceId, {
      ownerUserId: input.ownerUserId,
      runtime: input.runtime,
      operation,
    });
    const result = await operation;
    this.pendingEnsures.delete(input.workspaceId);
    return result;
  }

  async getConnection(input: WorkspaceProviderInput) {
    const vm = await this.findVm(input);
    if (vm instanceof Error || vm === undefined) return vm;
    const authorization = await this.api.vmAuthorization(vm.vm_name);
    if (authorization instanceof Error) return authorization;
    return {
      origin: `https://${vm.vm_name}.exe.xyz:8788`,
      authorization: {
        type: "headers",
        value: {
          authorization: `Bearer ${this.gatewayToken(input)}`,
          "x-exedev-authorization": authorization,
        },
      },
    } satisfies WorkspaceProviderConnection;
  }

  async pause(input: WorkspaceProviderInput) {
    const vmName = this.vmName(input);
    if (vmName instanceof Error) return vmName;
    const result = await this.api.execute(["pause", vmName]);
    if (result instanceof Error) return result;
  }

  async resume(input: WorkspaceProviderInput) {
    const vmName = this.vmName(input);
    if (vmName instanceof Error) return vmName;
    const result = await this.api.execute(["resume", vmName]);
    if (result instanceof Error) return result;
  }

  private async ensureWorkspace(input: WorkspaceProviderAssignment) {
    const vmName = this.vmName(input);
    if (vmName instanceof Error) return vmName;
    const existing = await this.findVm(input);
    if (existing instanceof Error) return existing;
    if (existing === undefined) {
      const cloned = await this.api.execute([
        "cp",
        this.templateVmName,
        vmName,
        "--copy-tags=false",
        "--json",
      ]);
      if (cloned instanceof Error) {
        // Another control-plane process can win the unique VM-name race.
        if (!(cloned instanceof ExeApiError) || cloned.status !== 422)
          return cloned;
        const winner = await this.findVm(input);
        if (winner instanceof Error) return winner;
        if (winner === undefined) return cloned;
      } else {
        const parsed = errore.try({
          // SAFETY: cloneSchema validates the untyped API response below.
          try: () => JSON.parse(cloned) as unknown,
          catch: (cause) =>
            new ExeWorkspaceProviderError({
              workspaceId: input.workspaceId,
              detail: "decode cloned VM",
              cause,
            }),
        });
        if (parsed instanceof Error) return parsed;
        if (!Value.Check(cloneSchema, parsed) || parsed.name !== vmName)
          return new ExeWorkspaceProviderError({
            workspaceId: input.workspaceId,
            detail: "clone did not return the requested VM name",
          });
      }
    }
    if (existing?.status === "paused") {
      const resumed = await this.resume(input);
      if (resumed instanceof Error) return resumed;
    }
    const assignment = Buffer.from(
      JSON.stringify({ ...input, gatewayToken: this.gatewayToken(input) }),
    ).toString("base64url");
    return await this.assign({
      input,
      vmName,
      assignment,
      // Another instance may have created this running VM before SSH is ready.
      attemptsRemaining: 30,
    });
  }

  private async assign(ctx: {
    input: WorkspaceProviderInput;
    vmName: string;
    assignment: string;
    attemptsRemaining: number;
  }): Promise<void | Error> {
    const assigned = await this.api.execute([
      "ssh",
      ctx.vmName,
      `sudo /usr/local/bin/halo-workspace-assign ${ctx.assignment}`,
    ]);
    // A real clone returned before SSH was reachable; Exe reports that as 422.
    if (
      assigned instanceof ExeApiError &&
      assigned.status === 422 &&
      ctx.attemptsRemaining > 0
    ) {
      await timers.setTimeout(250);
      return await this.assign({
        ...ctx,
        attemptsRemaining: ctx.attemptsRemaining - 1,
      });
    }
    if (assigned instanceof Error) return assigned;
    // /exec combines guest stdout/stderr; remote exit status is only a trailer.
    if (assigned.trim() !== "HALO_WORKSPACE_ASSIGNED")
      return new ExeWorkspaceProviderError({
        workspaceId: ctx.input.workspaceId,
        detail: "guest workspace assignment failed",
      });
  }

  private async findVm(input: WorkspaceProviderInput) {
    const vmName = this.vmName(input);
    if (vmName instanceof Error) return vmName;
    const raw = await this.api.execute(["ls", vmName]);
    if (raw instanceof Error) return raw;
    const parsed = errore.try({
      // SAFETY: listSchema validates the untyped API response below.
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        new ExeWorkspaceProviderError({
          workspaceId: input.workspaceId,
          detail: "decode VM lookup",
          cause,
        }),
    });
    if (parsed instanceof Error) return parsed;
    if (!Value.Check(listSchema, parsed))
      return new ExeWorkspaceProviderError({
        workspaceId: input.workspaceId,
        detail: "invalid VM lookup response",
      });
    const vm = parsed.vms.find((candidate) => candidate.vm_name === vmName);
    if (vm !== undefined && vm.proxy_share !== "private")
      return new ExeWorkspaceProviderError({
        workspaceId: input.workspaceId,
        detail: "workspace VM ingress must be private",
      });
    return vm;
  }

  private vmName(input: WorkspaceProviderInput) {
    const vmName = `halo-${input.workspaceId}`;
    if (!/^[a-z][a-z0-9-]{0,62}$/u.test(vmName))
      return new ExeWorkspaceProviderError({
        workspaceId: input.workspaceId,
        detail: "invalid workspace VM name",
      });
    return vmName;
  }

  private gatewayToken(input: WorkspaceProviderInput) {
    // The seed stays on the control plane; each VM receives only its own token.
    return crypto
      .createHmac("sha256", this.gatewaySecret)
      .update(JSON.stringify([input.workspaceId, input.ownerUserId]))
      .digest("base64url");
  }
}
