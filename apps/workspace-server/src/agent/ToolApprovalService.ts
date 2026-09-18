import util from "node:util";
import * as errore from "errore";
import type { ToolApproval, ToolApprovalDecision } from "@get-halo/client";

export class ToolApprovalNotFoundError extends errore.createTaggedError({
  name: "ToolApprovalNotFoundError",
  message: "Tool approval '$approvalId' is no longer pending",
}) {}

export class ToolApprovalService {
  // Prevents duplicate responses while a decision is being persisted.
  private readonly decidedApprovalIds = new Set<string>();
  // Holds approvals until one matching Executor invocation consumes each grant.
  private readonly grants = new Map<string, ToolApproval>();

  decide(input: {
    approval: ToolApproval;
    decision: ToolApprovalDecision;
  }): ToolApprovalNotFoundError | undefined {
    if (this.decidedApprovalIds.has(input.approval.id)) {
      return new ToolApprovalNotFoundError({
        approvalId: input.approval.id,
      });
    }
    this.decidedApprovalIds.add(input.approval.id);
    if (input.decision === "allow") {
      this.grants.set(input.approval.id, input.approval);
    }
  }

  consume(input: { toolPath: string; arguments: unknown }) {
    const grant = [...this.grants.values()].find(
      (candidate) =>
        candidate.toolPath === input.toolPath &&
        util.isDeepStrictEqual(candidate.arguments, input.arguments),
    );
    if (grant === undefined) return false;
    this.grants.delete(grant.id);
    return true;
  }

  release(approvalId: string) {
    this.decidedApprovalIds.delete(approvalId);
    this.grants.delete(approvalId);
  }

  close() {
    this.decidedApprovalIds.clear();
    this.grants.clear();
  }
}
