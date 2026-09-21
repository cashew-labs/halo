import { useIsActiveTab } from "../../panes/WorkspacePanesProvider.js";
import { useMarkSessionRead } from "./useSessionReadState.js";
import { lastAssistantTurnWasAborted } from "./sessionView.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
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
import { ArrowUp, Stop, Paperclip, Close, FileText } from "maui/icons";
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
  type SessionSummary,
  type ChatPrompt,
  validateChatFiles,
} from "@get-halo/client";
import { AssistantMessage } from "./AssistantMessage.tsx";
import { Editor } from "./Editor.tsx";
import { ExecutorConnectionCard } from "./ExecutorConnectionCard.tsx";
import { ToolActivity } from "./ToolActivity.tsx";

export function AgentPane({
  sessionId,
  sessions,
}: {
  sessionId: string;
  sessions: SessionSummary[];
}) {
  const session = useAgentSession(sessionId);
  useMarkSessionRead({ sessionId, state: session.state });
  const sessionMeta = sessions.find(
    ({ sessionId: candidate }) => candidate === sessionId,
  );
  const { data: submittedTitle } = useQuery<string>({
    queryKey: sessionTitleQueryKey(sessionId),
    queryFn: skipToken,
  });
  return (
    <ChatPane
      key={sessionId}
      sessionId={sessionId}
      title={sessionMeta?.title ?? submittedTitle}
      {...session}
    />
  );
}

export function DraftAgentPane({ draftId }: { draftId: string }) {
  const [, navigate] = useLocation();
  const session = useDraftAgentSession((createdSessionId) => {
    navigate(`/sessions/${createdSessionId}`);
  });
  return (
    <ChatPane
      draftId={draftId}
      {...session}
      title={session.title ?? "New session"}
    />
  );
}

function ChatPane({
  sessionId,
  draftId,
  title,
  state,
  error,
  prompt,
  abort,
}: {
  sessionId: string | undefined;
  draftId?: string;
  title: string | undefined;
  state: SessionSnapshot;
  error: string | undefined;
  prompt: (input: ChatPrompt) => Promise<void | Error>;
  abort: () => Promise<void | Error>;
}) {
  const isActiveTab = useIsActiveTab();
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<{ id: string; file: File }[]>(
    [],
  );
  const [localError, setLocalError] = useState<string>();
  const [sending, setSending] = useState(false);
  const submitting = useRef<string | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const picker = useRef<HTMLInputElement>(null);
  const pane = useStyles(styles.pane);
  const body = useStyles(
    styles.body,
    draftId === undefined ? undefined : styles.bodyTop,
  );
  const column = useStyles(styles.column);
  const composer = useStyles(styles.composer);
  const liveStatus = useStyles(styles.liveStatus);
  const sendButton = useStyles(styles.sendButton);
  const attachmentList = useStyles(styles.attachmentList);
  const attachmentChip = useStyles(styles.attachmentChip);
  const attachmentName = useStyles(styles.attachmentName);
  const composerActions = useStyles(styles.composerActions);
  const progress = useStyles(styles.progress);
  const dropOverlay = useStyles(styles.dropOverlay);
  const hasContent = draft.trim().length > 0 || attachments.length > 0;
  const showStop = state.activeRun !== undefined && !hasContent && !sending;
  const displayError = localError ?? error;

  useEffect(() => {
    // The prompt RPC stays open for the model's whole turn. Release the composer
    // when our message is committed, so Stop and follow-up drafts remain usable.
    const id = submitting.current;
    if (
      id === undefined ||
      !state.entries.some(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          entry.message.clientMessageId === id,
      )
    )
      return;
    submitting.current = undefined;
    setSending(false);
    setDraft("");
    setAttachments([]);
  }, [state.entries]);

  function addFiles(files: File[]) {
    if (submitting.current) {
      setLocalError(
        "Wait for the current message to send before adding files.",
      );
      return;
    }
    const invalid = validateChatFiles([
      ...attachments.map((item) => item.file),
      ...files,
    ]);
    if (invalid !== undefined) {
      setLocalError(invalid);
      return;
    }
    setLocalError(undefined);
    setAttachments((current) => [
      ...current,
      ...files.map((file) => ({ id: crypto.randomUUID(), file })),
    ]);
  }

  async function submit() {
    if (!hasContent || submitting.current) return;
    const clientMessageId = crypto.randomUUID();
    submitting.current = clientMessageId;
    setSending(true);
    setLocalError(undefined);
    const result = await prompt({
      text: draft.trim(),
      files: attachments.map((item) => item.file),
      clientMessageId,
    });
    if (submitting.current !== clientMessageId) return;
    submitting.current = undefined;
    setSending(false);
    if (result instanceof Error) return;
    setDraft("");
    setAttachments([]);
  }

  return (
    <main
      className={pane}
      aria-label={title}
      data-draft-id={draftId}
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOverCapture={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        // File drops attach to the chat; do not show the editor's insertion cursor.
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDropCapture={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current = 0;
        setDragging(false);
        if (
          Array.from(event.dataTransfer.items).some(
            (item) => item.webkitGetAsEntry()?.isDirectory,
          )
        ) {
          setLocalError("Add individual files instead of a folder.");
          return;
        }
        addFiles(Array.from(event.dataTransfer.files));
      }}
      onPasteCapture={(event) => {
        const files = Array.from(event.clipboardData.files);
        if (files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        addFiles(files);
      }}
    >
      {dragging ? (
        <div className={dropOverlay}>Drop files to attach</div>
      ) : undefined}
      <div className={body}>
        <div className={column}>
          {draftId === undefined || state.entries.length > 0 ? (
            <SessionView state={state} sessionId={sessionId} />
          ) : undefined}
          <Editor
            autoFocus={isActiveTab}
            content={draft}
            onChange={setDraft}
            onSubmit={submit}
            editable={!sending}
            placeholder="Message Halo"
            aria-label="Message"
            size="sm"
            className={composer}
            header={
              attachments.length === 0 ? undefined : (
                <ul className={attachmentList} aria-label="Attachments">
                  {attachments.map(({ id, file }) => (
                    <li className={attachmentChip} key={id}>
                      <FileText size="sm" aria-hidden="true" />
                      <span className={attachmentName} title={file.name}>
                        {file.name}
                      </span>
                      <Button
                        variant="quiet"
                        aria-label={`Remove ${file.name}`}
                        isDisabled={sending}
                        onClick={() => {
                          setAttachments((current) =>
                            current.filter((item) => item.id !== id),
                          );
                          setLocalError(undefined);
                        }}
                      >
                        <Close size="sm" aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )
            }
            error={
              displayError === undefined ? undefined : (
                <div className={liveStatus} role="alert">
                  {displayError}
                </div>
              )
            }
            actions={
              <div className={composerActions}>
                <input
                  ref={picker}
                  type="file"
                  multiple
                  hidden
                  aria-label="Attach files"
                  onChange={(event) => {
                    addFiles(Array.from(event.currentTarget.files ?? []));
                    event.currentTarget.value = "";
                  }}
                />
                <Button
                  variant="quiet"
                  aria-label="Add attachments"
                  isDisabled={sending}
                  onClick={() => picker.current?.click()}
                >
                  <Paperclip size="sm" aria-hidden="true" />
                </Button>
                <span className={progress} role="status">
                  {sending
                    ? attachments.length > 0
                      ? "Preparing attachments…"
                      : "Sending…"
                    : ""}
                </span>
                <Button
                  aria-label={showStop ? "Stop" : "Send"}
                  className={sendButton}
                  isDisabled={sending || (!showStop && !hasContent)}
                  onClick={showStop ? abort : submit}
                >
                  {showStop ? (
                    <Stop size="sm" />
                  ) : (
                    <ArrowUp size="sm" aria-hidden="true" />
                  )}
                </Button>
              </div>
            }
          />
        </div>
      </div>
    </main>
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
  const followLatest = useRef(true);
  const viewedSessionId = useRef(sessionId);
  const view = useStyles(styles.view);
  const stopped = useStyles(styles.stopped);
  const items = sessionViewItems(state);
  const showStopped =
    state.activeRun === undefined &&
    lastAssistantTurnWasAborted(sessionMessages(state));

  useLayoutEffect(() => {
    if (viewedSessionId.current !== sessionId) {
      viewedSessionId.current = sessionId;
      followLatest.current = true;
    }
    const element = viewRef.current;
    if (element === null) return;
    const scrollToLatest = () => {
      if (followLatest.current) element.scrollTop = element.scrollHeight;
    };
    scrollToLatest();
    // Streamdown can resize message rows after the session render has committed.
    const observer = new ResizeObserver(scrollToLatest);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  });

  return (
    <div
      className={view}
      role="log"
      aria-label="Session transcript"
      aria-relevant="additions"
      ref={viewRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        followLatest.current =
          element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
      }}
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
  const attachmentList = useStyles(styles.attachmentList);
  const attachmentChip = useStyles(styles.attachmentChip);
  const attachmentName = useStyles(styles.attachmentName);

  if (item.kind === "user") {
    return (
      <div className={userRow}>
        <article className={userMessage} aria-label="You message">
          {item.text.length > 0 ? (
            <div className={body}>{item.text}</div>
          ) : undefined}
          {item.attachments.length > 0 ? (
            <ul className={attachmentList} aria-label="Attached files">
              {item.attachments.map((attachment) => (
                <li key={attachment.path}>
                  <Link
                    href={`/files/${encodeURIComponent(attachment.path)}`}
                    className={attachmentChip}
                  >
                    <FileText size="sm" aria-hidden="true" />
                    <span className={attachmentName} title={attachment.name}>
                      {attachment.name}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : undefined}
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
    position: "relative",
  }),
  body: style(
    flex({ direction: "column" }),
    spacing.padding({ x: 12, bottom: 12 }),
    {
      flex: "1 1 auto",
      width: "100%",
      minWidth: 0,
      minHeight: 0,
      "@media (max-width: 700px)": {
        paddingInline: "16px",
        paddingBottom: "max(16px, env(safe-area-inset-bottom))",
      },
    },
  ),
  bodyTop: style(spacing.padding({ top: 12 })),
  attachmentList: style(flex({ gap: 2 }), spacing.padding({ y: 2 }), {
    flexWrap: "wrap",
    listStyle: "none",
    paddingInline: 0,
    margin: 0,
    minWidth: 0,
  }),
  attachmentChip: style(
    flex({ alignItems: "center", gap: 2 }),
    radius.md,
    spacing.padding({ x: 3, y: 1 }),
    text({ size: "xs", color: "highContrast" }),
    {
      backgroundColor: colors.grayAlpha[3],
      maxWidth: "100%",
      minWidth: 0,
      textDecoration: "none",
      "&:hover": { backgroundColor: colors.grayAlpha[4] },
    },
  ),
  attachmentName: style({
    maxWidth: "28ch",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  }),
  composerActions: style(flex({ alignItems: "center", gap: 2 }), {
    width: "100%",
  }),
  progress: style(text({ size: "xs", color: "lowContrast" }), { flex: 1 }),
  dropOverlay: style(
    radius.lg,
    text({ size: "md", fontWeight: 500, color: "highContrast" }),
    {
      position: "absolute",
      inset: spacing.value(4),
      zIndex: 10,
      display: "grid",
      placeItems: "center",
      pointerEvents: "none",
      backgroundColor: `color-mix(in srgb, ${backgroundColor.element} 80%, transparent)`,
      border: `2px dashed ${colors.gray[7]}`,
    },
  ),
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
  userRow: style(flex({ justifyContent: "end" }), spacing.padding({ top: 3 }), {
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
