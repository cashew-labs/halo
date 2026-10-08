import { useRestartWarning } from "../../confirmRestart.js";
import { useIsActiveTab } from "../../panes/WorkspacePanesProvider.js";
import { useMarkSessionRead } from "./useMarkSessionRead.js";
import { lastAssistantTurnWasAborted } from "./sessionView.js";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
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
  type ChatReference,
  validateChatFiles,
} from "@get-halo/client";
import { AssistantMessage } from "./AssistantMessage.tsx";
import { BashExecution } from "./BashExecution.tsx";
import { Editor } from "./Editor.tsx";
import { referenceHref, type ReferenceTarget } from "../ReferencePicker.js";
import { ExecutorApprovalCard } from "./ExecutorApprovalCard.tsx";
import { ExecutorConnectionCard } from "./ExecutorConnectionCard.tsx";
import { ToolActivity } from "./ToolActivity.tsx";
import { useTabFindSource } from "../../panes/TabFind.js";
import { useConnection } from "../../api/ConnectionContext.js";
import {
  useWorkspacePathsQuery,
  useWorkspaceQuery,
} from "../../api/ApiProvider.js";
import { draftReferencesQueryKey } from "../chatReferences.js";
import {
  clearMessageDraft,
  useMessageDraft,
  useMessageDraftKey,
} from "./useMessageDraft.js";

export function AgentPane({
  sessionId,
  sessions,
}: {
  sessionId: string;
  sessions: SessionSummary[];
}) {
  const session = useAgentSession(sessionId);
  const draftKey = useMessageDraftKey({
    kind: "session",
    messageId: sessionId,
  });
  const sessionMeta = sessions.find(
    ({ sessionId: candidateSessionId }) => candidateSessionId === sessionId,
  );
  useMarkSessionRead({ session: sessionMeta, state: session.state });
  const { data: submittedTitle } = useQuery<string>({
    queryKey: sessionTitleQueryKey(sessionId),
    queryFn: skipToken,
  });
  return (
    <ChatPane
      sessionId={sessionId}
      draftKey={draftKey}
      title={sessionMeta?.title ?? submittedTitle}
      sessions={sessions}
      {...session}
    />
  );
}

export function DraftAgentPane({
  draftId,
  sessions,
}: {
  draftId: string;
  sessions: SessionSummary[];
}) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const initialReferences = queryClient.getQueryData<ChatReference[]>(
    draftReferencesQueryKey(draftId),
  );
  const draftKey = useMessageDraftKey({ kind: "draft", messageId: draftId });
  const session = useDraftAgentSession((createdSessionId) => {
    clearMessageDraft(draftKey);
    navigate(`/sessions/${createdSessionId}`);
  });
  return (
    <ChatPane
      draftId={draftId}
      initialReferences={initialReferences}
      draftKey={draftKey}
      {...session}
      title={session.title ?? "New session"}
      sessions={sessions}
    />
  );
}

function ChatPane({
  sessionId,
  draftId,
  initialReferences = [],
  draftKey,
  title,
  sessions,
  state,
  error,
  prompt,
  abort,
}: {
  sessionId: string | undefined;
  draftId?: string;
  initialReferences?: ChatReference[];
  draftKey: string | undefined;
  title: string | undefined;
  sessions: SessionSummary[];
  state: SessionSnapshot;
  error: string | undefined;
  prompt: (input: ChatPrompt) => Promise<void | Error>;
  abort: () => Promise<void | Error>;
}) {
  const isActiveTab = useIsActiveTab();
  const { state: connection } = useConnection();
  const [draft, setDraft] = useMessageDraft(draftKey);
  const [references, setReferences] =
    useState<ChatReference[]>(initialReferences);
  const workspace = useWorkspaceQuery().data;
  const paths = useWorkspacePathsQuery(workspace).data?.filter(
    (path) => !path.endsWith("/"),
  );
  const referenceTargets: ReferenceTarget[] = [
    ...(paths ?? []).map((path) => ({ kind: "file" as const, path })),
    ...sessions
      .filter((session) => session.sessionId !== sessionId)
      .map((session) => ({
        kind: "session" as const,
        sessionId: session.sessionId,
        title: session.title ?? session.sessionId,
      })),
  ];
  const [attachments, setAttachments] = useState<{ id: string; file: File }[]>(
    [],
  );
  const [localError, setLocalError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [optimisticMessage, setOptimisticMessage] = useState<
    Extract<SessionViewItem, { kind: "user" }> | undefined
  >();
  const submitting = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
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
  const connectionMessage = {
    connecting: "Connecting to your workspace…",
    reconnecting: "Connection lost. Automatically reconnecting…",
    offline: "You're offline. Halo will reconnect when you're back online.",
    synchronizing: "Connection restored. Updating your chat…",
    connected: undefined,
    authentication: "Click “Sign in required” in the sidebar to reconnect.",
    incompatible:
      "An app or server update is needed. Click the connection status in the sidebar for details.",
  }[connection.status];
  const banner = useStyles(
    styles.banner,
    connectionMessage === undefined ? styles.errorBanner : undefined,
  );
  const sendButton = useStyles(styles.sendButton);
  const attachmentList = useStyles(styles.attachmentList);
  const attachmentChip = useStyles(styles.attachmentChip);
  const attachmentName = useStyles(styles.attachmentName);
  const referenceExcerpt = useStyles(styles.referenceExcerpt);
  const composerActions = useStyles(styles.composerActions);
  const progress = useStyles(styles.progress);
  const dropOverlay = useStyles(styles.dropOverlay);
  const hasContent =
    draft.trim().length > 0 || attachments.length > 0 || references.length > 0;
  useRestartWarning(attachments.length > 0 || references.length > 0);
  const showStop = state.activeRun !== undefined && !hasContent && !sending;
  const displayError = localError ?? error;
  const bannerMessage = connectionMessage ?? displayError;
  const visibleOptimisticMessage =
    optimisticMessage !== undefined &&
    state.entries.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "user" &&
        entry.message.clientMessageId === optimisticMessage.id,
    )
      ? undefined
      : optimisticMessage;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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
    setOptimisticMessage(undefined);
    setDraft("");
    setAttachments([]);
    setReferences([]);
  }, [state.entries, setDraft]);

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
    const submittedDraft = draft;
    const submittedAttachments = attachments;
    const submittedReferences = references;
    submitting.current = clientMessageId;
    clearMessageDraft(draftKey);
    setSending(true);
    setLocalError(undefined);
    if (state.activeRun !== undefined) {
      setOptimisticMessage({
        kind: "user",
        id: clientMessageId,
        text: submittedDraft.trim(),
        attachments: submittedAttachments.map(({ file }) => ({
          name: file.name,
        })),
        references: submittedReferences,
        pending: true,
      });
      setDraft("");
      setAttachments([]);
      setReferences([]);
    }
    const result = await prompt({
      text: submittedDraft.trim(),
      files: submittedAttachments.map((item) => item.file),
      references: submittedReferences,
      clientMessageId,
    });
    if (submitting.current !== clientMessageId) return;
    submitting.current = undefined;
    setSending(false);
    if (result instanceof Error) {
      if (mounted.current) {
        setOptimisticMessage(undefined);
        setDraft(submittedDraft);
        setAttachments(submittedAttachments);
        setReferences(submittedReferences);
      }
      return;
    }
    setDraft("");
    setAttachments([]);
    setReferences([]);
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
      {bannerMessage === undefined ? undefined : (
        <div
          className={banner}
          role={connectionMessage === undefined ? "alert" : "status"}
        >
          {bannerMessage}
        </div>
      )}
      <div className={body}>
        <div className={column}>
          {draftId === undefined || state.entries.length > 0 ? (
            <SessionView
              state={state}
              sessionId={sessionId}
              optimisticMessage={visibleOptimisticMessage}
            />
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
            referenceTargets={referenceTargets}
            referencePlacement={
              draftId !== undefined && state.entries.length === 0
                ? "below"
                : "above"
            }
            onAddReference={(target) => {
              const reference =
                target.kind === "file"
                  ? { path: target.path }
                  : { sessionId: target.sessionId, title: target.title };
              setReferences((current) =>
                current.some((item) =>
                  target.kind === "file"
                    ? "path" in item && item.path === target.path
                    : "sessionId" in item &&
                      item.sessionId === target.sessionId,
                )
                  ? current
                  : [...current, reference],
              );
            }}
            header={
              attachments.length === 0 &&
              references.length === 0 ? undefined : (
                <>
                  {references.length > 0 ? (
                    <ul className={attachmentList} aria-label="References">
                      {references.map((reference) => (
                        <li
                          className={attachmentChip}
                          key={
                            "sessionId" in reference
                              ? reference.sessionId
                              : reference.path
                          }
                        >
                          <FileText size="sm" aria-hidden="true" />
                          <span
                            className={attachmentName}
                            title={
                              "sessionId" in reference
                                ? reference.title
                                : reference.path
                            }
                          >
                            {"sessionId" in reference
                              ? reference.title
                              : reference.path}
                          </span>
                          {"text" in reference &&
                          reference.text !== undefined ? (
                            <span
                              className={referenceExcerpt}
                              title={reference.text}
                            >
                              “{reference.text}”
                            </span>
                          ) : undefined}
                          <Button
                            variant="quiet"
                            aria-label={`Remove reference ${"sessionId" in reference ? reference.title : reference.path}`}
                            isDisabled={sending}
                            onClick={() =>
                              setReferences((current) =>
                                current.filter((item) => item !== reference),
                              )
                            }
                          >
                            <Close size="sm" aria-hidden="true" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : undefined}
                  {attachments.length > 0 ? (
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
                  ) : undefined}
                </>
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
  optimisticMessage,
}: {
  state: SessionSnapshot;
  sessionId: string | undefined;
  optimisticMessage: Extract<SessionViewItem, { kind: "user" }> | undefined;
}) {
  const viewRef = useRef<HTMLDivElement>(null);
  const activeFindRange = useRef<Range | undefined>(undefined);
  const [findSource, setFindSource] = useState<{
    segments: { id: string; text: string }[];
    select: (segmentId: string, start: number, end: number) => void;
    highlight: (
      match: { segmentId: string; start: number; end: number } | undefined,
    ) => void;
  }>();
  useTabFindSource(findSource);
  const followLatest = useRef(true);
  const viewedSessionId = useRef(sessionId);
  const view = useStyles(styles.view);
  const stopped = useStyles(styles.stopped);
  const items = useMemo(() => sessionViewItems(state), [state]);
  // Publish the Find source after paint. A layout effect schedules a sync
  // re-render on every session event; when events arrive faster than this
  // view renders, React counts those nested updates until it throws
  // "Maximum update depth exceeded" and unmounts the window.
  useEffect(() => {
    const root = viewRef.current;
    if (root === null) return;
    const elements =
      state.entries.length > 0 || state.activeRun !== undefined
        ? Array.from(root.querySelectorAll<HTMLElement>("[data-find-segment]"))
        : [];
    const clearHighlight = () => {
      if (activeFindRange.current === undefined) return;
      CSS.highlights
        .get("halo-find-session-match")
        ?.delete(activeFindRange.current);
      activeFindRange.current = undefined;
    };
    const rangeFor = (segmentId: string, start: number, end: number) => {
      const element = elements.find(
        (item) => item.dataset.findSegment === segmentId,
      );
      if (element === undefined) return undefined;
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      while (walker.nextNode()) {
        // SAFETY: SHOW_TEXT restricts currentNode to Text nodes.
        nodes.push(walker.currentNode as Text);
      }
      const point = (offset: number) => {
        let remaining = offset;
        for (const node of nodes) {
          if (remaining <= node.length) return { node, offset: remaining };
          remaining -= node.length;
        }
        return { node: nodes.at(-1), offset: nodes.at(-1)?.length ?? 0 };
      };
      const from = point(start);
      const to = point(end);
      if (from.node === undefined || to.node === undefined) return undefined;
      const range = document.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      return range;
    };
    setFindSource({
      segments: elements.map((element) => ({
        id: element.dataset.findSegment!,
        text: element.textContent ?? "",
      })),
      select: (segmentId, start, end) => {
        const range = rangeFor(segmentId, start, end);
        if (range === undefined) return;
        followLatest.current = false;
        const viewport = root.getBoundingClientRect();
        const match = range.getBoundingClientRect();
        if (match.top < viewport.top || match.bottom > viewport.bottom)
          root.scrollTop +=
            match.top - viewport.top - (viewport.height - match.height) / 2;
      },
      highlight: (match) => {
        clearHighlight();
        if (match === undefined) return;
        const range = rangeFor(match.segmentId, match.start, match.end);
        if (range === undefined) return;
        const highlight =
          CSS.highlights.get("halo-find-session-match") ?? new Highlight();
        highlight.add(range);
        CSS.highlights.set("halo-find-session-match", highlight);
        activeFindRange.current = range;
      },
    });
    return clearHighlight;
  }, [state]);
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
      {optimisticMessage === undefined ? undefined : (
        <SessionViewRow
          key={optimisticMessage.id}
          item={optimisticMessage}
          sessionId={sessionId}
        />
      )}
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
  const userMessage = useStyles(
    styles.userMessage,
    item.kind === "user" && item.pending
      ? styles.pendingUserMessage
      : undefined,
  );
  const body = useStyles(styles.messageBody);
  const assistantRow = useStyles(styles.assistantRow);
  const assistantMessage = useStyles(styles.assistantMessage);
  const attachmentList = useStyles(styles.attachmentList);
  const attachmentChip = useStyles(styles.attachmentChip);
  const attachmentName = useStyles(styles.attachmentName);
  const referenceExcerpt = useStyles(styles.referenceExcerpt);

  if (item.kind === "bashExecution")
    return <BashExecution message={item.message} />;

  if (item.kind === "user") {
    return (
      <div className={userRow}>
        <article
          className={userMessage}
          aria-label="You message"
          aria-busy={item.pending}
        >
          {item.text.length > 0 ? (
            <div className={body} data-find-segment={item.id}>
              {item.text}
            </div>
          ) : undefined}
          {item.attachments.length > 0 ? (
            <ul className={attachmentList} aria-label="Attached files">
              {item.attachments.map((attachment) => (
                <li key={attachment.path ?? attachment.name}>
                  {attachment.path === undefined ? (
                    <span className={attachmentChip}>
                      <FileText size="sm" aria-hidden="true" />
                      <span className={attachmentName} title={attachment.name}>
                        {attachment.name}
                      </span>
                    </span>
                  ) : (
                    <Link
                      href={`/files/${attachment.path.split("/").map(encodeURIComponent).join("/")}`}
                      className={attachmentChip}
                    >
                      <FileText size="sm" aria-hidden="true" />
                      <span className={attachmentName} title={attachment.name}>
                        {attachment.name}
                      </span>
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          ) : undefined}
          {item.references.length > 0 ? (
            <ul className={attachmentList} aria-label="References">
              {item.references.map((reference, index) => (
                <li
                  key={`${"sessionId" in reference ? reference.sessionId : reference.path}-${index}`}
                >
                  <Link
                    href={referenceHref(
                      "sessionId" in reference
                        ? {
                            kind: "session",
                            sessionId: reference.sessionId,
                            title: reference.title,
                          }
                        : { kind: "file", path: reference.path },
                    )}
                    className={attachmentChip}
                  >
                    <FileText size="sm" aria-hidden="true" />
                    <span
                      className={attachmentName}
                      title={
                        "sessionId" in reference
                          ? reference.title
                          : reference.path
                      }
                    >
                      {"sessionId" in reference
                        ? reference.title
                        : reference.path}
                    </span>
                    {"text" in reference && reference.text !== undefined ? (
                      <span className={referenceExcerpt} title={reference.text}>
                        “{reference.text}”
                      </span>
                    ) : undefined}
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
        if (part.kind === "toolApproval") {
          return (
            <ExecutorApprovalCard
              key={part.id}
              sessionId={sessionId}
              part={part}
            />
          );
        }
        return (
          <div key={part.id} data-find-segment={part.id}>
            <AssistantMessage
              size="sm"
              className={assistantMessage}
              isAnimating={part.streaming}
            >
              {part.text}
            </AssistantMessage>
          </div>
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
  referenceExcerpt: style(text({ size: "xs", color: "lowContrast" }), {
    maxWidth: "18ch",
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
      "& ::highlight(halo-find-session-match)": {
        backgroundColor: colors.amber[5],
      },
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
  banner: style(
    flexItem({ size: "hug" }),
    text({ size: "sm", fontWeight: 500, color: "highContrast" }),
    spacing.padding({ x: 12, y: 4 }),
    {
      color: colors.amber[11],
      backgroundColor: colors.amber[3],
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
    },
  ),
  errorBanner: style({
    color: colors.red[11],
    backgroundColor: colors.red[3],
  }),
  userRow: style(flex({ justifyContent: "end" }), spacing.padding({ top: 3 }), {
    // position: "sticky",
    // top: 0,
    // zIndex: 1,
    minWidth: 0,
    backgroundColor: backgroundColor.app,
  }),
  userMessage: style(radius.xl, spacing.padding({ x: 6, y: 3 }), {
    width: "fit-content",
    maxWidth: "80%",
    minWidth: 0,
    backgroundColor: colors.gray[3],
  }),
  pendingUserMessage: style({ opacity: 0.6 }),
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
