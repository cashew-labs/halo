import { useMutation } from "@tanstack/react-query";
import { background, Button, Flex, radius, shadow, Text } from "maui";
import { Mail } from "maui/icons";
import { style, useStyles } from "purse-styles";
import type { ToolApproval, ToolApprovalDecision } from "@get-halo/client";
import { useApi } from "../../api/ApiProvider.tsx";
import type { SessionViewPart } from "./sessionView.ts";

type ExecutorApprovalPart = Extract<SessionViewPart, { kind: "toolApproval" }>;

const card = style(background.element, radius.lg, shadow.subtle, {
  width: "100%",
  maxWidth: "400px",
});

export function ExecutorApprovalCard({
  sessionId,
  part,
}: {
  sessionId: string | undefined;
  part: ExecutorApprovalPart;
}) {
  const cardClassName = useStyles(card);
  const api = useApi();
  const approval = part.approval;
  const copy = approvalCopy(approval);
  const respond = useMutation({
    mutationFn: async (decision: ToolApprovalDecision) => {
      // SAFETY: both actions are disabled until sessionId is a string.
      const activeSessionId = sessionId as string;
      await api.sessions.respondToToolApproval({
        sessionId: activeSessionId,
        approvalId: approval.id,
        decision,
      });
    },
    onError: (error) => {
      console.warn("Tool approval response failed:", error);
    },
  });
  const pending = approval.status === "pending";

  return (
    <section
      aria-label={`${copy.title} approval`}
      data-session-id={sessionId}
      data-tool-path={approval.toolPath}
      data-testid="executor-approval-card"
      className={cardClassName}
    >
      <Flex column gap={6} p={6}>
        <Flex column gap={4} alignItems="start">
          <Flex row gap={4}>
            <Mail size="lg" />
            <Flex column gap={1}>
              <Text size="md" fontWeight={600}>
                {copy.title}
              </Text>
              <Text size="sm" color="lowContrast">
                {pending ? copy.description : approvalStatusLabel(approval)}
              </Text>
            </Flex>
          </Flex>
          {pending ? (
            <Flex
              row
              gap={3}
              style={{ width: "100%", justifyContent: "flex-end" }}
            >
              <Button
                variant="quiet"
                disabled={sessionId === undefined || respond.isPending}
                onClick={() => respond.mutate("deny")}
              >
                Deny
              </Button>
              <Button
                variant="primary"
                variantColor="#1A73E8"
                disabled={sessionId === undefined || respond.isPending}
                onClick={() => respond.mutate("allow")}
              >
                Allow once
              </Button>
            </Flex>
          ) : undefined}
        </Flex>
      </Flex>
    </section>
  );
}

function approvalCopy(approval: ToolApproval) {
  if (approval.toolPath.endsWith(".gmail.users.drafts.create")) {
    return {
      title: "Create Gmail draft?",
      description:
        "The agent wants to create a draft reply in your Gmail account.",
    };
  }
  return {
    title: "Approve this tool action?",
    description: approval.message,
  };
}

function approvalStatusLabel(approval: ToolApproval) {
  if (approval.status === "allowed") return "Allowed once";
  if (approval.status === "denied") return "Denied";
  if (approval.status === "cancelled") return "Cancelled";
  return approvalCopy(approval).description;
}
