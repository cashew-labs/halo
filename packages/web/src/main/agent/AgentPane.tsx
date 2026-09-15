import { lastAssistantTurnWasAborted } from "./sessionView.js";
import { useLayoutEffect, useRef, useState } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Button,
  backgroundColor,
  colors,
  flex,
  flexItem,
  radius,
  shadowVars,
  spacing,
  text,
} from "maui";
import { ArrowUp, Stop } from "maui/icons";
import { style, useStyles } from "purse-styles";
import {
  sessionTitleQueryKey,
  useAgentSession,
  useDraftAgentSession,
} from "./useAgentSession.ts";
import { sessionViewItems, type SessionViewItem } from "./sessionView.ts";
import {
  sessionMessages,
  type SessionSnapshot,
} from "@get-halo/shared/sessionState";
import { AssistantMessage } from "./AssistantMessage.tsx";
import { Editor } from "./Editor.tsx";
import { ExecutorConnectionCard } from "./ExecutorConnectionCard.tsx";
import { ToolActivity } from "./ToolActivity.tsx";
import { type SessionSummary } from "@get-halo/shared/rpc";
import { PaneHeader } from "../PaneHeader.tsx";

export function AgentPane({
  sessionId,
  sessions,
}: {
  sessionId: string;
  sessions: SessionSummary[];
}) {
  const pane = useStyles(styles.pane);
  const body = useStyles(styles.body);
  const column = useStyles(styles.column);
  const { state, error, prompt, abort } = useAgentSession(sessionId);
  const sessionMeta = sessions.find(
    ({ sessionId: candidate }) => candidate === sessionId,
  );
  const { data: submittedTitle } = useQuery<string>({
    queryKey: sessionTitleQueryKey(sessionId),
    queryFn: skipToken,
  });
  const title =
    sessionMeta?.title === undefined ? submittedTitle : sessionMeta.title;

  return (
    <main className={pane} aria-label={title}>
      <PaneHeader title={title} />
      <div className={body}>
        <div className={column}>
          <SessionView state={state} sessionId={sessionId} />
          <Composer
            key={sessionId}
            autoFocus
            error={error}
            isWorking={state.activeRun !== undefined}
            onSubmit={prompt}
            onStop={abort}
          />
        </div>
      </div>
    </main>
  );
}

export function DraftAgentPane({ draftId }: { draftId: string }) {
  const [, navigate] = useLocation();
  const { state, error, sessionId, title, prompt, abort } =
    useDraftAgentSession((createdSessionId) => {
      navigate(`/sessions/${createdSessionId}`);
    });
  const pane = useStyles(styles.pane);
  const body = useStyles(styles.body, styles.bodyTop);
  const column = useStyles(styles.column);
  const hasMessages = sessionViewItems(state).length > 0;

  return (
    <main
      className={pane}
      aria-label={title === undefined ? "New session" : title}
      data-draft-id={draftId}
    >
      <PaneHeader title={title} />
      <div className={body}>
        <div className={column}>
          {hasMessages ? (
            <SessionView state={state} sessionId={sessionId} />
          ) : undefined}
          <Composer
            autoFocus
            error={error}
            isWorking={state.activeRun !== undefined}
            onSubmit={prompt}
            onStop={abort}
          />
        </div>
      </div>
    </main>
  );
}

function Composer({
  autoFocus,
  error,
  isWorking,
  onSubmit,
  onStop,
}: {
  autoFocus: boolean;
  error: string | undefined;
  isWorking: boolean;
  onSubmit: (prompt: string) => Promise<void | Error>;
  onStop: () => Promise<void | Error>;
}) {
  const [draft, setDraft] = useState("");
  const composer = useStyles(styles.composer);
  const liveStatus = useStyles(styles.liveStatus);
  const sendButton = useStyles(styles.sendButton);
  const trimmedText = draft.trim();
  const showStop = isWorking && trimmedText.length === 0;

  async function submit() {
    if (!trimmedText) return;

    setDraft("");
    const result = await onSubmit(trimmedText);
    if (result instanceof Error) {
      setDraft(trimmedText);
    }
  }

  return (
    <Editor
      autoFocus={autoFocus}
      content={draft}
      onChange={setDraft}
      onSubmit={submit}
      placeholder="Message Halo"
      aria-label="Message"
      size="sm"
      className={composer}
      error={
        error === undefined ? undefined : (
          <div className={liveStatus} role="alert">
            {error}
          </div>
        )
      }
      actions={
        <Button
          aria-label={showStop ? "Stop" : "Send"}
          className={sendButton}
          disabled={!showStop && trimmedText.length === 0}
          onClick={showStop ? onStop : submit}
        >
          {showStop ? (
            <Stop size="sm" />
          ) : (
            <ArrowUp size="sm" aria-hidden="true" />
          )}
        </Button>
      }
    />
  );
}

function SessionView({
  state,
  sessionId,
}: {
  state: SessionSnapshot;
  sessionId: string | undefined;
}) {
  const viewRef = useRef<HTMLDivElement>(null);
  const view = useStyles(styles.view);
  const stopped = useStyles(styles.stopped);
  const items = sessionViewItems(state);
  const showStopped =
    state.activeRun === undefined &&
    lastAssistantTurnWasAborted(sessionMessages(state));

  useLayoutEffect(() => {
    const element = viewRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  });

  return (
    <div
      className={view}
      role="log"
      aria-label="Session transcript"
      aria-relevant="additions"
      ref={viewRef}
    >
      {items.map((item) => (
        <SessionViewRow key={item.id} item={item} sessionId={sessionId} />
      ))}
      {showStopped ? (
        <span className={stopped} role="status">
          Stopped
        </span>
      ) : undefined}
    </div>
  );
}

function SessionViewRow({
  item,
  sessionId,
}: {
  item: SessionViewItem;
  sessionId: string | undefined;
}) {
  const userRow = useStyles(styles.userRow);
  const userMessage = useStyles(styles.userMessage);
  const body = useStyles(styles.messageBody);
  const assistantRow = useStyles(styles.assistantRow);
  const assistantMessage = useStyles(styles.assistantMessage);

  if (item.kind === "user") {
    return (
      <div className={userRow}>
        <article className={userMessage} aria-label="You message">
          <div className={body}>{item.text}</div>
        </article>
      </div>
    );
  }

  return (
    <div className={assistantRow} aria-label="Assistant message">
      {item.parts.map((part) => {
        if (part.kind === "toolActivity") {
          return <ToolActivity key={part.id} part={part} />;
        }
        if (part.kind === "executorConnection") {
          return (
            <ExecutorConnectionCard
              key={part.id}
              sessionId={sessionId}
              part={part}
            />
          );
        }
        return (
          <AssistantMessage
            key={part.id}
            size="sm"
            className={assistantMessage}
            isAnimating={part.streaming}
          >
            {part.text}
          </AssistantMessage>
        );
      })}
    </div>
  );
}

const styles = {
  pane: style(flex({ direction: "column" }), {
    width: "100%",
    marginInline: "auto",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    backgroundColor: backgroundColor.app,
  }),
  body: style(
    flex({ direction: "column" }),
    spacing.padding({ x: 12, bottom: 12 }),
    {
      flex: "1 1 auto",
      width: "100%",
      minWidth: 0,
      minHeight: 0,
    },
  ),
  bodyTop: style(spacing.padding({ top: 12 })),
  column: style(flex({ direction: "column" }), {
    flex: "1 1 auto",
    width: "100%",
    maxWidth: "72ch",
    minWidth: 0,
    minHeight: 0,
    marginInline: "auto",
  }),
  view: style(
    flex({ direction: "column", gap: 6 }),
    flexItem({
      size: "auto",
    }),
    {
      minWidth: 0,
      minHeight: 0,
      overflowY: "auto",
      overscrollBehavior: "contain",
      scrollbarWidth: "none",
      // overflow-y: auto clips child box-shadows; padding keeps the 1px ring inside the scrollport.
      paddingInline: spacing.value(2),
      paddingTop: spacing.value(12),
      paddingBottom: spacing.value(6),
      "&::-webkit-scrollbar": { display: "none" },
    },
  ),
  composer: style(flexItem({ size: "hug" }), {
    width: "100%",
    maxWidth: "none",
    minWidth: 0,
    position: "relative",
    zIndex: 1,
    overflow: "visible",
    marginTop: spacing.value(2),
    "&:focus-within": {
      outline: "none",
      boxShadow: shadowVars.subtle,
      zIndex: "auto",
    },
    "&::before": {
      position: "absolute",
      right: 0,
      bottom: "calc(100% + 1px)",
      left: 0,
      height: spacing.value(6),
      content: "''",
      pointerEvents: "none",
      background: `linear-gradient(to bottom, transparent, ${backgroundColor.app})`,
    },
  }),
  liveStatus: style(
    flexItem({ size: "hug" }),
    text({ size: "xs", fontWeight: 500, color: "highContrast" }),
    spacing.padding({ x: 4, y: 2 }),
    {
      color: "light-dark(#b42318, #ff9592)",
      backgroundColor: "light-dark(#ffebe9, #3b1219)",
      borderRadius: "8px",
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
    },
  ),
  userRow: style(flex({ justify: "end" }), spacing.padding({ top: 3 }), {
    // position: "sticky",
    // top: 0,
    // zIndex: 1,
    minWidth: 0,
    backgroundColor: backgroundColor.app,
  }),
  userMessage: style(radius.lg, spacing.padding({ x: 6, y: 3 }), {
    width: "fit-content",
    maxWidth: "80%",
    minWidth: 0,
    backgroundColor: colors.gray[3],
  }),
  assistantRow: style(flex({ direction: "column", gap: 6 }), {
    minWidth: 0,
    width: "100%",
    alignSelf: "stretch",
  }),
  assistantMessage: style({
    maxWidth: "none",
    width: "100%",
  }),
  stopped: style(text({ size: "md", fontWeight: 500, color: "highContrast" }), {
    alignSelf: "flex-end",
  }),
  messageBody: style(
    text({ size: "md", fontWeight: 400, color: "highContrast" }),
    {
      minWidth: 0,
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
    },
  ),
  sendButton: style(radius.circle, {
    boxShadow: "none",
    backgroundColor: colors.grayAlpha[4],
    "&:hover": {
      backgroundColor: colors.grayAlpha[5],
    },
    "&:active": {
      backgroundColor: colors.grayAlpha[6],
    },
  }),
};
