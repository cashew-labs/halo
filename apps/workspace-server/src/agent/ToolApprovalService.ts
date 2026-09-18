import * as errore from "errore";
import type { ToolApproval, ToolApprovalDecision } from "@get-halo/client";

export class ToolApprovalNotFoundError extends errore.createTaggedError({
  name: "ToolApprovalNotFoundError",
  message: "Tool approval '$approvalId' is no longer pending",
}) {}

export type ToolApprovalResponse = ToolApprovalDecision | "cancel";

type PendingApproval = {
  resolve: (response: ToolApprovalResponse) => void;
  signal: AbortSignal | undefined;
  onAbort: () => void;
};

export class ToolApprovalService {
  // Tracks tool executions waiting for a response from this session's user.
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  async request(input: {
    approval: ToolApproval;
    signal: AbortSignal | undefined;
  }): Promise<ToolApprovalResponse> {
    return await new Promise<ToolApprovalResponse>((resolve) => {
      const onAbort = () => this.finish(input.approval.id, "cancel");
      this.pendingApprovals.set(input.approval.id, {
        resolve,
        signal: input.signal,
        onAbort,
      });
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) this.finish(input.approval.id, "cancel");
    });
  }

  respond(input: {
    approvalId: string;
    decision: ToolApprovalDecision;
  }): ToolApprovalNotFoundError | undefined {
    if (!this.pendingApprovals.has(input.approvalId)) {
      return new ToolApprovalNotFoundError({
        approvalId: input.approvalId,
      });
    }
    this.finish(input.approvalId, input.decision);
  }

  close() {
    for (const approvalId of this.pendingApprovals.keys()) {
      this.finish(approvalId, "cancel");
    }
  }

  private finish(approvalId: string, response: ToolApprovalResponse) {
    const pending = this.pendingApprovals.get(approvalId);
    if (pending === undefined) return;
    this.pendingApprovals.delete(approvalId);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    pending.resolve(response);
  }
}
