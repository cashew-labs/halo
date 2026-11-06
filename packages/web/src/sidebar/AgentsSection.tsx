import { useEffect, useRef, useState } from "react";
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
  backgroundColor,
  colors,
  flex,
  motion,
  motionEasing,
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
import { BotAvatar } from "../agents/BotAvatar.js";
import {
  useMessageDraft,
  useMessageDraftKey,
} from "../main/agent/useMessageDraft.js";
import {
  useWorkspacePanes,
  usePaneLocation,
} from "../panes/WorkspacePanesProvider.js";
import { useSidebar } from "../WorkspaceLayout.js";

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
  const initial = useStyles(styles.initial);
  const avatar = useStyles(styles.avatar);
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
      <div className={avatar}>
        <Tooltip
          content={
            <AgentPreview agent={agent} thread={thread} status={status} />
          }
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
            {agent.avatar === undefined ? (
              <Text
                className={initial}
                size="lg"
                fontWeight={500}
                aria-hidden="true"
              >
                {Array.from(agent.name)[0]?.toLocaleUpperCase()}
              </Text>
            ) : (
              <BotAvatar
                avatar={agent.avatar}
                size={28}
                still={!selected}
                followPointer={selected}
                label=""
              />
            )}
          </Button>
        </Tooltip>
        {thread !== undefined && <AgentActivity thread={thread} />}
      </div>
      <Text
        className={name}
        size="xs"
        color={selected ? "accent" : undefined}
        fontWeight={selected ? 500 : undefined}
        title={agent.name}
      >
        {agent.name}
      </Text>
    </div>
  );
}

// A dot for unread results that stretches into a typing bubble while the agent works.
function AgentActivity({ thread }: { thread: ThreadSummary }) {
  const isUnread = !thread.isRunning && isThreadUnread(thread);
  const dots = useRef<HTMLSpanElement>(null);
  const badge = useStyles(
    styles.badge,
    thread.isRunning ? styles.working : isUnread ? styles.unread : styles.idle,
  );
  const dotRow = useStyles(styles.dots, thread.isRunning && styles.visibleDots);
  const dot = useStyles(styles.dot);
  useEffect(() => {
    if (!thread.isRunning) return;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    let bounces: Animation[] = [];
    // Start or stop the bounce whenever the reduced-motion setting changes.
    const update = () => {
      bounces.forEach((bounce) => bounce.cancel());
      bounces = reducedMotion.matches
        ? []
        : Array.from(dots.current?.children ?? [], (child, index) =>
            child.animate(
              // Ease each hop, not the whole loop, so the keyframes keep their timing.
              [
                { transform: "translateY(0)", easing: motionEasing },
                {
                  transform: "translateY(-2px)",
                  offset: 0.25,
                  easing: motionEasing,
                },
                { transform: "translateY(0)", offset: 0.5 },
                { transform: "translateY(0)" },
              ],
              { duration: 1000, delay: index * 160, iterations: Infinity },
            ),
          );
    };
    update();
    reducedMotion.addEventListener("change", update);
    return () => {
      reducedMotion.removeEventListener("change", update);
      bounces.forEach((bounce) => bounce.cancel());
    };
  }, [thread.isRunning]);
  const label = thread.isRunning
    ? "Agent is working"
    : isUnread
      ? "Unread result"
      : undefined;
  return (
    <span
      className={badge}
      role="img"
      aria-label={label}
      aria-hidden={label === undefined}
      title={label}
    >
      <span ref={dots} className={dotRow}>
        <span className={dot} />
        <span className={dot} />
        <span className={dot} />
      </span>
    </span>
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
  }),
  selected: style({ boxShadow: `0 0 0 2px ${colors.accent[8]}` }),
  // Trim the line box to the capital so the letter sits in the optical center.
  initial: style({ textBox: "trim-both cap alphabetic" }),
  name: style({
    maxWidth: "100%",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  }),
  avatar: style({ position: "relative" }),
  // Centered on the dot's center, so the working oval grows out both sides.
  badge: style(
    motion.standard("width", "background-color", "opacity", "scale"),
    radius.pill,
    {
      position: "absolute",
      left: "35px",
      top: "35px",
      translate: "-50% -50%",
      pointerEvents: "none",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      boxSizing: "border-box",
      height: "14px",
      border: `2px solid ${backgroundColor.element}`,
      "@media (prefers-reduced-motion: reduce)": { transition: "none" },
    },
  ),
  unread: style({ width: "14px", backgroundColor: colors.accent[9] }),
  working: style({ width: "26px", backgroundColor: colors.gray[5] }),
  idle: style({
    width: "14px",
    backgroundColor: colors.accent[9],
    opacity: 0,
    scale: "0.5",
  }),
  dots: style(motion.standard("opacity"), {
    display: "flex",
    gap: "2px",
    opacity: 0,
  }),
  visibleDots: style({ opacity: 1 }),
  dot: style(radius.circle, {
    width: "3px",
    height: "3px",
    backgroundColor: colors.gray[11],
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
