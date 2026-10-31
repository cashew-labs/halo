import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  agentUserMessage,
  isThreadUnread,
  type AgentRecord,
  type ThreadSummary,
} from "@get-halo/client";
import {
  Button,
  Flex,
  Text,
  Tooltip,
  background,
  colors,
  flex,
  radius,
  shadow,
  spacing,
  text,
  tooltipStyles,
} from "maui";
import { Plus } from "maui/icons";
import { style, useStyles } from "purse-styles";
import { useAgents } from "../api/WorkspaceUpdatesProvider.js";
import { useConnection } from "../api/ConnectionContext.js";
import { useApi, useWorkspaceQuery } from "../api/ApiProvider.js";
import { AgentDialog } from "../agents/AgentDialog.js";
import {
  useMessageDraft,
  useMessageDraftKey,
} from "../main/agent/useMessageDraft.js";
import {
  useWorkspacePanes,
  usePaneLocation,
} from "../panes/WorkspacePanesProvider.js";
import { useSidebar } from "../WorkspaceLayout.js";
import { ThreadActivity } from "./ThreadActivity.js";

export function AgentsSection({ threads }: { threads: ThreadSummary[] }) {
  const agents = useAgents();
  const { service } = useConnection();
  const [open, setOpen] = useState(false);
  const workspace = useWorkspacePanes();
  const sidebar = useSidebar();
  const section = useStyles(styles.section);
  const roster = useStyles(styles.roster);
  return (
    <section className={section} aria-label="Agents">
      <Flex row alignItems="center" justifyContent="between">
        <Text size="xs" color="lowContrast" fontWeight={500}>
          Agents
        </Text>
        <Button
          variant="quiet"
          size="sm"
          aria-label="New agent"
          onPress={() => setOpen(true)}
        >
          <Plus size="sm" />
        </Button>
      </Flex>
      {agents.error !== undefined && (
        <Flex column gap={2}>
          <Text role="alert" size="xs">
            Couldn't load agents. Retry to reconnect.
          </Text>
          <Button size="sm" onPress={service.retry}>
            Retry
          </Button>
        </Flex>
      )}
      {agents.data === undefined ? (
        agents.error === undefined && (
          <Text role="status" size="xs" color="lowContrast">
            Loading agents…
          </Text>
        )
      ) : agents.data.length === 0 ? (
        <Text size="xs" color="lowContrast">
          Create an agent to keep a conversation going.
        </Text>
      ) : (
        <div className={roster}>
          {agents.data.map((agent) => (
            <AgentCircle
              key={agent.id}
              agent={agent}
              thread={threads.find(
                (thread) => thread.sessionId === agent.threadId,
              )}
            />
          ))}
        </div>
      )}
      <AgentDialog
        isOpen={open}
        onOpenChange={setOpen}
        onCreated={(agent) => {
          workspace.open({ path: `/sessions/${agent.threadId}` });
          sidebar.close();
        }}
      />
    </section>
  );
}

function AgentCircle({
  agent,
  thread,
}: {
  agent: AgentRecord;
  thread: ThreadSummary | undefined;
}) {
  const [path] = usePaneLocation();
  const selected = path === `/sessions/${agent.threadId}`;
  const workspace = useWorkspacePanes();
  const sidebar = useSidebar();
  const circle = useStyles(styles.circle, selected && styles.selected);
  const item = useStyles(styles.item);
  const name = useStyles(styles.name);
  const activity = useStyles(styles.activity);
  const status =
    thread === undefined
      ? "Loading conversation"
      : thread.isRunning
        ? "Working"
        : isThreadUnread(thread)
          ? "Unread"
          : "Ready";
  return (
    <div className={item}>
      <Tooltip
        content={<AgentPreview agent={agent} thread={thread} status={status} />}
        placement="top"
      >
        <Button
          className={circle}
          aria-label={agent.name}
          aria-pressed={selected}
          onPress={() => {
            workspace.open({ path: `/sessions/${agent.threadId}` });
            sidebar.close();
          }}
        >
          <Text size="lg" fontWeight={500} aria-hidden="true">
            {Array.from(agent.name)[0]?.toLocaleUpperCase()}
          </Text>
          {thread !== undefined && (
            <div className={activity}>
              <ThreadActivity thread={thread} />
            </div>
          )}
        </Button>
      </Tooltip>
      <Text className={name} size="xs" title={agent.name}>
        {agent.name}
      </Text>
    </div>
  );
}

function AgentPreview({
  agent,
  thread,
  status,
}: {
  agent: AgentRecord;
  thread: ThreadSummary | undefined;
  status: string;
}) {
  const api = useApi();
  const workspaceRoot = useWorkspaceQuery().data?.workspaceRoot;
  const key = useMessageDraftKey({ kind: "thread", messageId: agent.threadId });
  const [draft] = useMessageDraft(key);
  // Maui mounts tooltip content only while it is visible; no background thread watches.
  const preview = useQuery({
    queryKey: [
      "agent-preview",
      workspaceRoot,
      agent.threadId,
      thread?.updatedAt,
    ],
    queryFn: async () =>
      await api.thread.snapshot({ sessionId: agent.threadId }),
    enabled: draft.trim() === "" && thread !== undefined,
  });
  const delivered = preview.data?.entries
    .flatMap((entry) => {
      const message = agentUserMessage(entry);
      return message === undefined ? [] : [message.text];
    })
    .at(-1);
  const summary =
    draft.trim() !== ""
      ? `Draft: ${draft}`
      : (delivered ??
        (preview.isError
          ? "Preview unavailable"
          : preview.isFetching
            ? "Loading preview…"
            : status));
  const card = useStyles(styles.preview);
  const heading = useStyles(styles.previewName);
  const excerpt = useStyles(styles.excerpt);
  return (
    <div className={card}>
      <Text className={heading} size="sm" fontWeight={500}>
        {agent.name}
      </Text>
      <Text className={excerpt} size="sm" color="lowContrast">
        {summary.replace(/\s+/g, " ").trim()}
      </Text>
    </div>
  );
}

const styles = {
  section: style({ paddingInline: spacing.value(4), flexShrink: 0 }),
  roster: style({
    display: "flex",
    flexWrap: "wrap",
    gap: spacing.value(4),
    paddingBlock: spacing.value(4),
    maxHeight: "180px",
    overflowY: "auto",
  }),
  item: style(flex({ direction: "column", alignItems: "center", gap: 2 }), {
    width: "60px",
    minWidth: 0,
  }),
  circle: style(radius.circle, text({ color: "lowContrast" }), {
    width: "40px",
    height: "40px",
    minWidth: "40px",
    padding: 0,
    position: "relative",
  }),
  selected: style({
    backgroundColor: colors.accent[3],
    color: colors.accent[11],
    boxShadow: `0 0 0 2px ${colors.accent[8]}`,
  }),
  name: style({
    maxWidth: "100%",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  }),
  activity: style({
    position: "absolute",
    right: "-4px",
    bottom: "-3px",
    pointerEvents: "none",
  }),
  preview: style(
    flex({ direction: "column", gap: 2 }),
    radius.xl,
    shadow.medium,
    background.element,
    {
      width: "260px",
      maxWidth: "100%",
      padding: spacing.value(6),
      [`${tooltipStyles.root}:has(&)`]: {
        maxWidth: "min(280px, calc(100vw - 24px))",
        padding: 0,
        border: 0,
        backgroundColor: "transparent",
        pointerEvents: "none" as const,
      },
    },
  ),
  previewName: style({
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  }),
  excerpt: style({
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
    overflow: "hidden",
    overflowWrap: "anywhere",
  }),
};
