import { useRestartWarning } from "../../confirmRestart.js";
import { useIsActiveTab } from "../../panes/WorkspacePanesProvider.js";
import { PaneHeaderActions } from "../../panes/PaneHeader.js";
import { DoneButton } from "./DoneButton.js";
import { useAgents } from "../../api/WorkspaceUpdatesProvider.js";
import { AgentSettingsButton } from "../../agents/AgentSettingsButton.js";
import { useMarkThreadRead } from "./useMarkThreadRead.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import {
  Button,
  Flex,
  Text,
  Tooltip,
  backgroundColor,
  colors,
  controlSize,
  flex,
  flexItem,
  radius,
  shadowVars,
  spacing,
  text,
} from "maui";
import { ArrowUp, Stop, Paperclip, Close, FileText, Refresh } from "maui/icons";
import { style, useStyles } from "purse-styles";
import {
  threadTitleQueryKey,
  useAgentThread,
  useDraftAgentThread,
  type ThreadPrompt,
} from "./useAgentThread.ts";
import { threadViewItems, type ThreadViewItem } from "./threadView.ts";
import {
  type ThreadSnapshot,
  type ThreadSummary,
  type ChatReference,
  validateChatFiles,
} from "@get-halo/client";
import { MessageContent } from "./MessageContent.js";
import { BashExecution } from "./BashExecution.tsx";
import { Editor } from "./Editor.tsx";
import { referenceHref, type ReferenceTarget } from "../ReferencePicker.js";
import { ExecutorApprovalCard } from "./ExecutorApprovalCard.tsx";
import { ExecutorConnectionCard } from "./ExecutorConnectionCard.tsx";
import { ToolActivity } from "./ToolActivity.tsx";
import { useTabFindSource } from "../../panes/TabFind.js";
import { useConnection } from "../../api/ConnectionContext.js";
import { useApi } from "../../api/ApiProvider.js";
import * as errore from "errore";
import { draftReferencesQueryKey } from "../chatReferences.js";
import {
  clearMessageDraft,
  useMessageDraft,
  useMessageDraftKey,
} from "./useMessageDraft.js";
import type { ChatUpload } from "./ChatUploads.js";
import type { OutboxMessage } from "./ChatOutbox.js";
import { useChatOutbox } from "./ChatOutboxProvider.js";
import { useRefCurrent } from "./useRefCurrent.js";

class WithdrawMessageError extends errore.createTaggedError({
  name: "WithdrawMessageError",
  message: "Couldn't remove your queued message. Please try again.",
}) {}

type QueuedMessage = Extract<ThreadViewItem, { kind: "user" }> & {
  draft: {
    text: string;
    attachmentIds: string[];
    files: File[];
    references: ChatReference[];
  };
  submissionId?: number;
  /** Not sent yet; it sends once its attachments finish uploading. */
  waiting?: true;
  /** Its prompt is on the way to the server, so it cannot be withdrawn. */
  sending?: true;
  /** When it was sent from the composer; queued rows show in this order. */
  queuedAt: number;
};

function outboxQueuedMessage(message: OutboxMessage): QueuedMessage {
  const queued: QueuedMessage = {
    kind: "user",
    id: message.messageId,
    text: message.draft.text.trim(),
    attachments: message.draft.files.map((file) => ({ name: file.name })),
    references: message.draft.references,
    pending: true,
    draft: message.draft,
    queuedAt: message.queuedAt,
  };
  if (message.submissionId !== undefined)
    queued.submissionId = message.submissionId;
  if (message.state !== "sent") queued.waiting = true;
  if (message.state === "sending") queued.sending = true;
  return queued;
}

export function AgentPane({
  threadId,
  threads,
}: {
  threadId: string;
  threads: ThreadSummary[];
}) {
  const thread = useAgentThread(threadId);
  const agents = useAgents();
  const { service } = useConnection();
  const agent = agents.data?.find((record) => record.threadId === threadId);
  const draftKey = useMessageDraftKey({
    kind: "thread",
    messageId: threadId,
  });
  const threadMeta = threads.find(
    ({ sessionId: candidateThreadId }) => candidateThreadId === threadId,
  );
  const agentPending =
    agent === undefined &&
    (agents.data === undefined ||
      threadMeta?.agentId !== undefined ||
      thread.state.agentId !== undefined);
  useMarkThreadRead({
    thread: agentPending ? undefined : threadMeta,
    state: thread.state,
  });
  const { data: submittedTitle } = useQuery<string>({
    queryKey: threadTitleQueryKey(threadId),
    queryFn: skipToken,
  });
  if (agentPending)
    return (
      <Flex column padding={12} gap={4}>
        <Text role={agents.error === undefined ? "status" : "alert"} size="sm">
          {agents.error === undefined
            ? "Loading conversation…"
            : "Couldn't load agent settings. Retry to reconnect."}
        </Text>
        {agents.error !== undefined && (
          <Button onPress={service.retry}>Retry</Button>
        )}
      </Flex>
    );
  return (
    <>
      {agent !== undefined ? (
        <PaneHeaderActions>
          <AgentSettingsButton agent={agent} />
        </PaneHeaderActions>
      ) : (
        threadMeta !== undefined && (
          <PaneHeaderActions>
            <DoneButton thread={threadMeta} />
          </PaneHeaderActions>
        )
      )}
      <ChatPane
        threadId={threadId}
        draftKey={draftKey}
        title={agent?.name ?? threadMeta?.title ?? submittedTitle}
        agentName={agent?.name}
        threads={threads}
        {...thread}
      />
    </>
  );
}

export function DraftAgentPane({
  draftId,
  threads,
}: {
  draftId: string;
  threads: ThreadSummary[];
}) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const initialReferences = queryClient.getQueryData<ChatReference[]>(
    draftReferencesQueryKey(draftId),
  );
  const draftKey = useMessageDraftKey({ kind: "draft", messageId: draftId });
  const thread = useDraftAgentThread((createdThreadId) => {
    clearMessageDraft(draftKey);
    navigate(`/sessions/${createdThreadId}`);
  });
  return (
    <ChatPane
      draftId={draftId}
      initialReferences={initialReferences}
      draftKey={draftKey}
      {...thread}
      title={thread.title ?? "New thread"}
      threads={threads}
    />
  );
}

function ChatPane({
  threadId,
  draftId,
  initialReferences = [],
  draftKey,
  title,
  agentName,
  threads,
  state,
  error,
  prompt,
  abort,
}: {
  threadId: string | undefined;
  draftId?: string;
  initialReferences?: ChatReference[];
  draftKey: string | undefined;
  title: string | undefined;
  agentName?: string;
  threads: ThreadSummary[];
  state: ThreadSnapshot;
  error: string | undefined;
  prompt: (input: ThreadPrompt) => Promise<{ submissionId: number } | Error>;
  abort: () => Promise<void | Error>;
}) {
  const isActiveTab = useIsActiveTab();
  const api = useApi();
  const { state: connection } = useConnection();
  const agents = useAgents().data;
  const [draft, setDraft] = useMessageDraft(draftKey);
  const [references, setReferences] =
    useState<ChatReference[]>(initialReferences);
  const referenceTargets: ReferenceTarget[] = threads
    .filter((thread) => thread.sessionId !== threadId)
    .map((thread) => ({
      kind: "thread" as const,
      threadId: thread.sessionId,
      title:
        agents?.find((record) => record.threadId === thread.sessionId)?.name ??
        thread.title ??
        thread.sessionId,
    }));
  const outbox = useChatOutbox();
  const { uploads } = outbox;
  const outboxMessages = useSyncExternalStore(
    useCallback((onChange) => outbox.state.subscribe(onChange), [outbox]),
    () => outbox.state.latestValue,
  );
  const uploadStates = useSyncExternalStore(
    useCallback((onChange) => uploads.state.subscribe(onChange), [uploads]),
    () => uploads.state.latestValue,
  );
  // Attachment IDs in the composer, in the order they were added.
  // A new thread's pane keeps its draft ID after the thread is created.
  const composerId = draftId ?? threadId ?? "";
  const attachments = useSyncExternalStore(
    useCallback((onChange) => outbox.drafts.subscribe(onChange), [outbox]),
    () => outbox.draftAttachments(composerId),
  );
  function setAttachments(attachmentIds: readonly string[]) {
    outbox.setDraftAttachments(composerId, attachmentIds);
  }
  const [localError, setLocalError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [withdrawing, setWithdrawing] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [optimisticMessages, setOptimisticMessages] = useState<QueuedMessage[]>(
    [],
  );
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
    upgrading: undefined,
    connecting: "Connecting to your cloud workspace…",
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
  const composerUploads = attachments.flatMap((attachmentId) => {
    const upload = uploadStates.get(attachmentId);
    return upload === undefined ? [] : [upload];
  });
  const composerUploading = composerUploads.some(
    (upload) => upload.state === "uploading",
  );
  const draftRef = useRefCurrent({ draft, references });
  const composerBusy = sending || withdrawing !== undefined || stopping;
  const showStop =
    state.activeRun !== undefined && !hasContent && !composerBusy;
  const displayError = localError ?? error;
  const bannerMessage = connectionMessage ?? displayError;
  const committedMessageIds = useMemo(
    () =>
      new Set(
        state.entries.flatMap((entry) =>
          entry.type === "message" && entry.message.role === "user"
            ? [entry.message.clientMessageId]
            : [],
        ),
      ),
    [state.entries],
  );
  const visibleOptimisticMessages = optimisticMessages.filter(
    (message) => !committedMessageIds.has(message.id),
  );
  // This thread's messages that wait for uploads or are not shown yet.
  const threadOutbox = outboxMessages.filter(
    (message) =>
      message.threadId === threadId &&
      message.state !== "returned" &&
      !committedMessageIds.has(message.messageId),
  );
  const outboxBusy = threadOutbox.some(
    (message) => message.state === "waiting" || message.state === "sending",
  );
  const queuedMessages: QueuedMessage[] = [
    ...threadOutbox.map(outboxQueuedMessage),
    ...visibleOptimisticMessages,
    // oxlint-disable-next-line unicorn/no-array-sort -- This new array is owned here; the web package targets ES2022.
  ].sort((left, right) => left.queuedAt - right.queuedAt);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const restoreRef = useRefCurrent(restoreToDraft);
  useEffect(() => {
    if (threadId === undefined) return;
    // Messages that could not be sent come back to this composer, including
    // ones that failed while the pane was closed.
    return outbox.state.subscribe(() => {
      const returned = outbox.takeReturned(threadId);
      if (returned.length === 0) return;
      const failed = returned.find((message) => message.error !== undefined);
      if (failed !== undefined) setLocalError(failed.error);
      restoreRef.current(
        returned.map((message) => message.draft),
        returned.flatMap((message) => message.draft.attachmentIds),
      );
    });
  }, [outbox, threadId, restoreRef]);

  useEffect(
    () => outbox.forget(committedMessageIds),
    [outbox, committedMessageIds],
  );

  useEffect(() => {
    // A committed message can arrive before its acceptance RPC returns.
    const id = submitting.current;
    if (id === undefined || !committedMessageIds.has(id)) return;
    submitting.current = undefined;
    setSending(false);
    setDraft("");
    outbox.setDraftAttachments(composerId, []);
    setReferences([]);
  }, [committedMessageIds, setDraft, outbox, composerId]);

  function addFiles(files: File[]) {
    if (submitting.current || withdrawing !== undefined) {
      setLocalError(
        "Wait for the current message to send before adding files.",
      );
      return;
    }
    const invalid = validateChatFiles([
      ...composerUploads.map((upload) => upload.file),
      ...files,
    ]);
    if (invalid !== undefined) {
      setLocalError(invalid);
      return;
    }
    setLocalError(undefined);
    setAttachments([...attachments, ...uploads.add(files)]);
  }

  /** Appends queued messages to the composer, keeping their uploads. */
  function restoreToDraft(
    drafts: readonly { text: string; references: ChatReference[] }[],
    attachmentIds: readonly string[],
  ) {
    const current = draftRef.current;
    setDraft(
      [current.draft, ...drafts.map((restored) => restored.text)]
        .filter((content) => content.length > 0)
        .join("\n\n"),
    );
    setAttachments([...outbox.draftAttachments(composerId), ...attachmentIds]);
    setReferences([
      ...new Map(
        [
          ...current.references,
          ...drafts.flatMap((restored) => restored.references),
        ].map((reference) => [JSON.stringify(reference), reference]),
      ).values(),
    ]);
    setFocusRequest((count) => count + 1);
  }

  async function withdrawMessage(messageId: string) {
    if (composerBusy) return;
    const waiting = outbox.withdraw(messageId);
    if (waiting !== undefined) {
      setLocalError(undefined);
      restoreToDraft([waiting.draft], waiting.draft.attachmentIds);
      return;
    }
    const message = queuedMessages.find(
      (candidate) => candidate.id === messageId,
    );
    if (message === undefined) return;
    if (message.submissionId === undefined || threadId === undefined) return;
    const restoredFiles = message.draft.files;
    const invalid = validateChatFiles([
      ...composerUploads.map((upload) => upload.file),
      ...restoredFiles,
    ]);
    if (invalid !== undefined) {
      setLocalError(invalid);
      return;
    }
    setWithdrawing(messageId);
    setLocalError(undefined);
    const result = await api.thread
      .withdraw({ sessionId: threadId, submissionId: message.submissionId })
      .catch((cause) => new WithdrawMessageError({ cause }));
    setWithdrawing(undefined);
    if (result instanceof Error) {
      console.warn("Failed to withdraw queued message:", result);
      setLocalError(result.message);
      return;
    }
    if (!result.withdrawn) {
      setLocalError(
        "This message has already been picked up and can no longer be removed from the queue.",
      );
      return;
    }
    setOptimisticMessages((messages) =>
      messages.filter((candidate) => candidate.id !== messageId),
    );
    outbox.forget([messageId]);
    // The server kept the sent uploads as attachments, so upload them again.
    restoreToDraft([message], uploads.add(restoredFiles));
  }

  async function stop() {
    if (stopping) return;
    setStopping(true);
    setLocalError(undefined);
    // Messages still waiting for uploads have not reached the server.
    const cancelledMessageIds = new Set(
      queuedMessages
        .filter((message) => !message.waiting)
        .map((message) => message.id),
    );
    const result = await abort();
    setStopping(false);
    if (result instanceof Error) {
      setLocalError(result.message);
      return;
    }
    // Stop withdraws queued inputs as well as aborting the active turn.
    setOptimisticMessages((messages) =>
      messages.filter((message) => !cancelledMessageIds.has(message.id)),
    );
    outbox.forget(cancelledMessageIds);
  }

  async function submit() {
    if (
      !hasContent ||
      submitting.current ||
      withdrawing !== undefined ||
      stopping
    )
      return;
    const failed = composerUploads.find((upload) => upload.state === "failed");
    if (failed !== undefined) {
      setLocalError(`Retry or remove ${failed.file.name} before sending.`);
      return;
    }
    const clientMessageId = crypto.randomUUID();
    const message: QueuedMessage = {
      kind: "user",
      id: clientMessageId,
      text: draft.trim(),
      attachments: composerUploads.map((upload) => ({
        name: upload.file.name,
      })),
      references,
      pending: true,
      queuedAt: Date.now(),
      draft: {
        text: draft,
        attachmentIds: [...attachments],
        files: composerUploads.map((upload) => upload.file),
        references,
      },
    };
    // An open thread keeps the composer free while files upload. A new
    // thread needs its first message accepted before it can queue more.
    if (
      draftId === undefined &&
      threadId !== undefined &&
      (composerUploading || outboxBusy)
    ) {
      clearMessageDraft(draftKey);
      setLocalError(undefined);
      outbox.enqueue({
        messageId: clientMessageId,
        threadId,
        draft: message.draft,
        queuedAt: message.queuedAt,
      });
      setDraft("");
      setAttachments([]);
      setReferences([]);
      return;
    }
    submitting.current = clientMessageId;
    clearMessageDraft(draftKey);
    setSending(true);
    setLocalError(undefined);
    if (state.activeRun !== undefined) {
      setOptimisticMessages((messages) => [
        ...messages.filter(
          (candidate) => !committedMessageIds.has(candidate.id),
        ),
        message,
      ]);
      setDraft("");
      setAttachments([]);
      setReferences([]);
    }
    const uploadIds = await uploads.uploadIds(message.draft.attachmentIds);
    if (uploadIds instanceof Error) setLocalError(uploadIds.message);
    const result =
      uploadIds instanceof Error
        ? uploadIds
        : await prompt({
            text: message.text,
            uploadIds,
            files: message.draft.files,
            references: message.draft.references,
            clientMessageId,
          });
    if (!(result instanceof Error))
      uploads.consume(message.draft.attachmentIds);
    if (submitting.current !== clientMessageId) return;
    submitting.current = undefined;
    setSending(false);
    if (result instanceof Error) {
      if (mounted.current) {
        setOptimisticMessages((messages) =>
          messages.filter((candidate) => candidate.id !== clientMessageId),
        );
        setDraft(message.draft.text);
        setAttachments(message.draft.attachmentIds);
        setReferences(message.draft.references);
      }
      return;
    }
    setOptimisticMessages((messages) =>
      messages.map((candidate) =>
        candidate.id === clientMessageId
          ? { ...candidate, submissionId: result.submissionId }
          : candidate,
      ),
    );
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
            <ThreadView
              state={state}
              threadId={threadId}
              optimisticMessages={queuedMessages}
              uploads={uploadStates}
              onWithdraw={withdrawMessage}
              queueDisabled={composerBusy}
            />
          ) : undefined}
          <Editor
            autoFocus={isActiveTab}
            focusRequest={focusRequest}
            content={draft}
            onChange={setDraft}
            onSubmit={submit}
            editable={!composerBusy}
            placeholder={
              agentName === undefined ? "Message Halo" : `Message ${agentName}`
            }
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
                  : { sessionId: target.threadId, title: target.title };
              setReferences((current) =>
                current.some((item) =>
                  target.kind === "file"
                    ? "path" in item && item.path === target.path
                    : "sessionId" in item && item.sessionId === target.threadId,
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
                          key={JSON.stringify(reference)}
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
                            isDisabled={composerBusy}
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
                      {attachments.map((attachmentId) => {
                        const upload = uploadStates.get(attachmentId);
                        if (upload === undefined) return undefined;
                        const { name } = upload.file;
                        return (
                          <li className={attachmentChip} key={attachmentId}>
                            <FileText size="sm" aria-hidden="true" />
                            <span className={attachmentName} title={name}>
                              {name}
                            </span>
                            <UploadStatus upload={upload} />
                            {upload.state === "failed" ? (
                              <Button
                                variant="quiet"
                                aria-label={`Retry ${name}`}
                                isDisabled={composerBusy}
                                onClick={() => {
                                  uploads.retry(attachmentId);
                                  setLocalError(undefined);
                                }}
                              >
                                <Refresh size="sm" aria-hidden="true" />
                              </Button>
                            ) : undefined}
                            <Button
                              variant="quiet"
                              aria-label={`Remove ${name}`}
                              isDisabled={composerBusy}
                              onClick={() => {
                                uploads.remove([attachmentId]);
                                setAttachments(
                                  attachments.filter(
                                    (item) => item !== attachmentId,
                                  ),
                                );
                                setLocalError(undefined);
                              }}
                            >
                              <Close size="sm" aria-hidden="true" />
                            </Button>
                          </li>
                        );
                      })}
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
                  isDisabled={composerBusy}
                  onClick={() => picker.current?.click()}
                >
                  <Paperclip size="sm" aria-hidden="true" />
                </Button>
                <span className={progress} role="status">
                  {sending
                    ? composerUploading
                      ? `Uploading attachments… ${uploadPercent(composerUploads)}%`
                      : attachments.length > 0
                        ? "Preparing attachments…"
                        : "Sending…"
                    : stopping
                      ? "Interrupting…"
                      : withdrawing !== undefined
                        ? "Removing queued message…"
                        : ""}
                </span>
                <Button
                  aria-label={showStop ? "Stop" : "Send"}
                  className={sendButton}
                  isDisabled={composerBusy || (!showStop && !hasContent)}
                  onClick={showStop ? stop : submit}
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

function ThreadView({
  state,
  threadId,
  optimisticMessages,
  uploads,
  onWithdraw,
  queueDisabled,
}: {
  state: ThreadSnapshot;
  threadId: string | undefined;
  optimisticMessages: QueuedMessage[];
  uploads: ReadonlyMap<string, ChatUpload>;
  onWithdraw: (messageId: string) => Promise<void>;
  queueDisabled: boolean;
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
  const viewedThreadId = useRef(threadId);
  const view = useStyles(styles.view);
  const items = useMemo(() => threadViewItems(state), [state]);
  // Publish the Find source after paint. A layout effect schedules a sync
  // re-render on every thread event; when events arrive faster than this
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
        .get("halo-find-thread-match")
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
          CSS.highlights.get("halo-find-thread-match") ?? new Highlight();
        highlight.add(range);
        CSS.highlights.set("halo-find-thread-match", highlight);
        activeFindRange.current = range;
      },
    });
    return clearHighlight;
  }, [state]);
  useLayoutEffect(() => {
    if (viewedThreadId.current !== threadId) {
      viewedThreadId.current = threadId;
      followLatest.current = true;
    }
    const element = viewRef.current;
    if (element === null) return;
    const scrollToLatest = () => {
      if (followLatest.current) element.scrollTop = element.scrollHeight;
    };
    scrollToLatest();
    // Streamdown can resize message rows after the thread render has committed.
    const observer = new ResizeObserver(scrollToLatest);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  });

  return (
    <div
      className={view}
      role="log"
      aria-label="Thread transcript"
      aria-relevant="additions"
      ref={viewRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        followLatest.current =
          element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
      }}
    >
      {items.map((item) => (
        <ThreadViewRow key={item.id} item={item} threadId={threadId} />
      ))}
      {optimisticMessages.map((message) => (
        <ThreadViewRow
          key={message.id}
          item={message}
          threadId={threadId}
          uploads={
            message.waiting
              ? message.draft.attachmentIds.map((attachmentId) =>
                  uploads.get(attachmentId),
                )
              : undefined
          }
          onWithdraw={async () => await onWithdraw(message.id)}
          queueDisabled={
            queueDisabled ||
            (message.waiting
              ? message.sending === true
              : message.submissionId === undefined)
          }
        />
      ))}
    </div>
  );
}

function ThreadViewRow({
  item,
  threadId,
  uploads,
  onWithdraw,
  queueDisabled,
}: {
  item: ThreadViewItem;
  threadId: string | undefined;
  /** Upload state for each attachment of a message that has not been sent. */
  uploads?: readonly (ChatUpload | undefined)[];
  onWithdraw?: () => Promise<void>;
  queueDisabled?: boolean;
}) {
  const userRow = useStyles(styles.userRow);
  const userMessage = useStyles(
    styles.userMessage,
    item.kind === "user" && item.pending
      ? styles.pendingUserMessage
      : undefined,
  );
  const queuedMessageAction = useStyles(styles.queuedMessageAction);
  const body = useStyles(styles.messageBody);
  const assistantRow = useStyles(styles.assistantRow);
  const assistantMessage = useStyles(styles.assistantMessage);
  const attachmentList = useStyles(styles.attachmentList);
  const attachmentChip = useStyles(styles.attachmentChip);
  const attachmentName = useStyles(styles.attachmentName);
  const referenceExcerpt = useStyles(styles.referenceExcerpt);
  const interruption = useStyles(styles.interruption);
  const waitingNote = useStyles(styles.waitingNote);

  if (item.kind === "interruption")
    return (
      <span className={interruption} role="status">
        Interrupted by user
      </span>
    );

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
              <MessageContent size="sm">{item.text}</MessageContent>
            </div>
          ) : undefined}
          {item.attachments.length > 0 ? (
            <ul className={attachmentList} aria-label="Attached files">
              {item.attachments.map((attachment, index) => (
                <li key={attachment.path ?? `${attachment.name}-${index}`}>
                  {attachment.path === undefined ? (
                    <span className={attachmentChip}>
                      <FileText size="sm" aria-hidden="true" />
                      <span className={attachmentName} title={attachment.name}>
                        {attachment.name}
                      </span>
                      {uploads?.[index] === undefined ? undefined : (
                        <UploadStatus upload={uploads[index]} />
                      )}
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
          {uploads === undefined ? undefined : (
            <span className={waitingNote}>
              Sends when its files finish uploading
            </span>
          )}
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
                            kind: "thread",
                            threadId: reference.sessionId,
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
        {onWithdraw === undefined ? undefined : (
          <Tooltip content="Remove from queue and move to draft">
            <Button
              variant="quiet"
              className={queuedMessageAction}
              aria-label="Move queued message to draft"
              isDisabled={queueDisabled}
              onClick={onWithdraw}
            >
              <Close size="sm" aria-hidden="true" />
            </Button>
          </Tooltip>
        )}
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
              threadId={threadId}
              part={part}
            />
          );
        }
        if (part.kind === "toolApproval") {
          return (
            <ExecutorApprovalCard
              key={part.id}
              threadId={threadId}
              part={part}
            />
          );
        }
        return (
          <div key={part.id} data-find-segment={part.id}>
            <MessageContent
              mode="streaming"
              size="sm"
              className={assistantMessage}
              isAnimating={part.streaming}
            >
              {part.text}
            </MessageContent>
          </div>
        );
      })}
    </div>
  );
}

function uploadPercent(uploads: readonly ChatUpload[]) {
  const size = uploads.reduce((total, upload) => total + upload.file.size, 0);
  const received = uploads.reduce(
    (total, upload) => total + upload.received,
    0,
  );
  return size === 0 ? 0 : Math.floor((received / size) * 100);
}

function UploadStatus({ upload }: { upload: ChatUpload }) {
  const status = useStyles(
    styles.uploadStatus,
    upload.state === "failed" ? styles.uploadFailed : undefined,
  );
  if (upload.state === "uploaded") return undefined;
  return (
    <span className={status} title={upload.error}>
      {upload.state === "failed"
        ? "Upload failed"
        : `${uploadPercent([upload])}%`}
    </span>
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
  uploadStatus: style(text({ size: "xs", color: "lowContrast" }), {
    flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
  }),
  uploadFailed: style({ color: colors.red[11] }),
  waitingNote: style(text({ size: "xs", color: "lowContrast" })),
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
      "& ::highlight(halo-find-thread-match)": {
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
    "& .ProseMirror": {
      maxHeight: "min(40dvh, 24rem)",
      overflowY: "auto",
      overscrollBehavior: "contain",
    },
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
  userRow: style(
    flex({ justifyContent: "end", alignItems: "start", gap: 2 }),
    spacing.padding({ top: 3 }),
    {
      // position: "sticky",
      // top: 0,
      // zIndex: 1,
      minWidth: 0,
      backgroundColor: backgroundColor.app,
    },
  ),
  userMessage: style(radius.xl, spacing.padding({ x: 6, y: 3 }), {
    position: "relative",
    width: "fit-content",
    maxWidth: "80%",
    minWidth: 0,
    backgroundColor: colors.gray[3],
  }),
  pendingUserMessage: style({ opacity: 0.6 }),
  queuedMessageAction: style({
    flexShrink: 0,
    "&&": { borderRadius: "100%" },
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
  interruption: style(
    text({ size: "sm", fontWeight: 500, color: "lowContrast" }),
    {
      alignSelf: "flex-end",
    },
  ),
  messageBody: style(
    text({ size: "md", fontWeight: 400, color: "highContrast" }),
    {
      minWidth: 0,
      whiteSpace: "pre-wrap",
      overflowWrap: "anywhere",
    },
  ),
  sendButton: style({
    boxShadow: "none",
    backgroundColor: colors.grayAlpha[4],
    "&&": {
      borderRadius: "100%",
      border: `1px solid ${colors.gray[6]}`,
      width: controlSize.height,
    },
    "&:disabled": {
      boxShadow: "none",
    },
    "&:hover": {
      backgroundColor: colors.grayAlpha[5],
    },
    "&:active": {
      backgroundColor: colors.grayAlpha[6],
    },
  }),
};
