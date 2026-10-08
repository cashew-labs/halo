import { useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import cronstrue from "cronstrue";
import * as errore from "errore";
import type {
  Routine,
  RoutineRunStatus,
  SessionSummary,
} from "@get-halo/client";
import {
  Button,
  Select,
  SelectItem,
  TextField,
  backgroundColor,
  flex,
  focusRing,
  radius,
  shadow,
  spacing,
  text,
} from "maui";
import { Pause, Pencil, Play } from "maui/icons";
import { style, useStyles } from "purse-styles";
import { useApi } from "../api/ApiProvider.js";
import { useRoutines } from "../api/WorkspaceUpdatesProvider.js";
import { useWorkspacePanes } from "../panes/WorkspacePanesProvider.js";

class ScheduleDescriptionError extends errore.createTaggedError({
  name: "ScheduleDescriptionError",
  message: "Could not describe the schedule '$cron'",
}) {}

const statusLabels = {
  queued: "Queued",
  cancelled: "Cancelled",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  skipped: "Skipped",
} satisfies Record<RoutineRunStatus, string>;

export function RoutinePane({
  routineId,
  sessions,
}: {
  routineId: string;
  sessions: SessionSummary[];
}) {
  const routines = useRoutines();
  const empty = useStyles(styles.empty);
  const routine = routines?.find((item) => item.id === routineId);
  if (routines === undefined)
    return <div className={empty}>Loading routine…</div>;
  if (routine === undefined)
    return (
      <div className={empty} role="status">
        This routine was removed. Sessions from its runs are still in the
        sidebar.
      </div>
    );
  return <RoutineView key={routine.id} routine={routine} sessions={sessions} />;
}

function RoutineView({
  routine,
  sessions,
}: {
  routine: Routine;
  sessions: SessionSummary[];
}) {
  const api = useApi();
  const workspace = useWorkspacePanes();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const runsQueryKey = ["routineRuns", routine.id];
  // The routine snapshot changes when a run starts or finishes, or a scheduled skip advances it.
  const runs = useQuery({
    queryKey: [
      ...runsQueryKey,
      routine.lastRun?.id,
      routine.lastRun?.status,
      routine.lastRun?.sessionId,
      routine.nextRunAt,
    ],
    queryFn: async () =>
      await api.routines.listRuns({ routineId: routine.id, limit: 50 }),
    placeholderData: keepPreviousData,
  });
  const runNow = useMutation({
    mutationFn: async () =>
      await api.routines.runNow({ routineId: routine.id }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: runsQueryKey });
    },
  });
  const pane = useStyles(styles.pane);
  const content = useStyles(styles.content);
  const titleRow = useStyles(styles.titleRow);
  const title = useStyles(styles.title);
  const actions = useStyles(styles.actions);
  const details = useStyles(styles.details);
  const errorText = useStyles(styles.error);
  const section = useStyles(styles.section);
  const sectionTitle = useStyles(styles.sectionTitle);
  const actionBody = useStyles(styles.actionBody);
  const list = useStyles(styles.list);
  const runLink = useStyles(styles.runLink);
  const runInfo = useStyles(styles.runInfo);
  const empty = useStyles(styles.empty);
  const actionText =
    routine.action.type === "runAgent"
      ? routine.action.prompt
      : routine.action.command;
  const actionLabel =
    routine.action.type === "runAgent" ? "Agent prompt" : "Script";
  const actionError = runNow.error ?? runs.error;
  const sessionRuns = runs.data?.filter((run) => run.sessionId !== undefined);

  return (
    <div className={pane} role="region" aria-label={`Routine ${routine.name}`}>
      <div className={content}>
        <header>
          <div className={titleRow}>
            <h2 className={title}>{routine.name}</h2>
            <div className={actions}>
              <Button
                variant="quiet"
                aria-label="Edit routine"
                onClick={() => setEditing(true)}
              >
                <Pencil size="sm" aria-hidden="true" />
              </Button>
              <Button
                isDisabled={runNow.isPending}
                onClick={() => runNow.mutate()}
              >
                Run now
              </Button>
            </div>
          </div>
          <dl className={details}>
            <div>
              <dt>Schedule</dt>
              <dd>
                {describeSchedule(routine.cron)} ({routine.timezone})
              </dd>
            </div>
            <div>
              <dt>Next run</dt>
              <dd>
                {routine.nextRunAt === undefined
                  ? "Paused"
                  : formatTime(routine.nextRunAt, routine.timezone)}
              </dd>
            </div>
            <div>
              <dt>Last run</dt>
              <dd>
                {routine.lastRun === undefined
                  ? "Never"
                  : `${statusLabels[routine.lastRun.status]} · ${formatTime(routine.lastRun.startedAt, routine.timezone)}`}
              </dd>
            </div>
            <div>
              <dt>After run</dt>
              <dd>
                {routine.autoArchiveSession
                  ? "Auto archive session"
                  : "Show session"}
              </dd>
            </div>
          </dl>
          {actionError === null ? undefined : (
            <div className={errorText} role="alert">
              {actionError.message}
            </div>
          )}
          {runNow.data?.status === "skipped" && (
            <div className={errorText} role="status">
              Skipped: {runNow.data.error}
            </div>
          )}
        </header>

        <section className={section} aria-label={actionLabel}>
          <h3 className={sectionTitle}>{actionLabel}</h3>
          <pre className={actionBody}>{actionText}</pre>
        </section>

        <section className={section} aria-label="Run sessions">
          <h3 className={sectionTitle}>Run sessions</h3>
          {sessionRuns === undefined ? (
            <p className={empty}>Loading runs…</p>
          ) : sessionRuns.length === 0 ? (
            <p className={empty}>
              No run sessions yet. Use Run now to start one.
            </p>
          ) : (
            <ul className={list}>
              {sessionRuns.map((run) => {
                if (run.sessionId === undefined) return undefined;
                const sessionId = run.sessionId;
                const session = sessions.find(
                  (item) => item.sessionId === sessionId,
                );
                return (
                  <li key={run.id}>
                    <a
                      className={runLink}
                      href={`/sessions/${encodeURIComponent(sessionId)}`}
                      onClick={(event) => {
                        event.preventDefault();
                        workspace.open({
                          path: `/sessions/${encodeURIComponent(sessionId)}`,
                          newTab: event.metaKey || event.ctrlKey,
                        });
                      }}
                    >
                      <span>
                        {session?.title ??
                          formatTime(run.startedAt, routine.timezone)}
                      </span>
                      <span className={runInfo}>
                        {formatRunTime(run.startedAt, routine.timezone)} ·{" "}
                        {statusLabels[run.status]} ·{" "}
                        {run.trigger === "manual" ? "Run now" : "Scheduled"}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      {editing && (
        <RoutineEditDialog
          routine={routine}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

function RoutineEditDialog({
  routine,
  onClose,
}: {
  routine: Routine;
  onClose(): void;
}) {
  const api = useApi();
  const [name, setName] = useState(routine.name);
  const [cron, setCron] = useState(routine.cron);
  const [timezone, setTimezone] = useState(routine.timezone);
  const [enabled, setEnabled] = useState(routine.enabled);
  const [autoArchiveSession, setAutoArchiveSession] = useState(
    routine.autoArchiveSession,
  );
  const [action, setAction] = useState(
    routine.action.type === "runAgent"
      ? routine.action.prompt
      : routine.action.command,
  );
  const save = useMutation({
    mutationFn: async () =>
      await api.routines.save({
        id: routine.id,
        extensionId: routine.extensionId,
        name: name.trim(),
        cron: cron.trim(),
        timezone: timezone.trim(),
        enabled,
        autoArchiveSession,
        action:
          routine.action.type === "runAgent"
            ? { type: "runAgent", prompt: action }
            : { ...routine.action, command: action },
      }),
    onSuccess: onClose,
  });
  const overlay = useStyles(styles.overlay);
  const modal = useStyles(styles.modal);
  const form = useStyles(styles.form);
  const heading = useStyles(styles.modalHeading);
  const label = useStyles(styles.label);
  const statusOption = useStyles(styles.statusOption);
  const editor = useStyles(styles.editor);
  const buttons = useStyles(styles.modalButtons);
  const error = useStyles(styles.error);
  const actionLabel =
    routine.action.type === "runAgent" ? "Agent prompt" : "Script";

  return (
    <ModalOverlay
      isOpen
      isDismissable={!save.isPending}
      isKeyboardDismissDisabled={save.isPending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className={overlay}
    >
      <Modal className={modal}>
        <Dialog aria-label={`Edit ${routine.name}`}>
          <form
            className={form}
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !save.isPending &&
                name.trim() &&
                cron.trim() &&
                timezone.trim() &&
                action.trim()
              )
                save.mutate();
            }}
          >
            <h2 className={heading}>Edit routine</h2>
            <label className={label}>
              Name
              <TextField
                aria-label="Name"
                value={name}
                onChange={setName}
                autoFocus
                isDisabled={save.isPending}
              />
            </label>
            <Select
              label="Workflow status"
              selectedKey={enabled ? "active" : "paused"}
              onSelectionChange={(key) => {
                if (key === null) return;
                setEnabled(key === "active");
              }}
              isDisabled={save.isPending}
            >
              <SelectItem id="active" textValue="Schedule active">
                <span className={statusOption}>
                  <Play size="sm" aria-hidden="true" />
                  Schedule active
                </span>
              </SelectItem>
              <SelectItem id="paused" textValue="Schedule paused">
                <span className={statusOption}>
                  <Pause size="sm" aria-hidden="true" />
                  Schedule paused
                </span>
              </SelectItem>
            </Select>
            <label className={label}>
              Schedule (cron)
              <TextField
                aria-label="Schedule (cron)"
                value={cron}
                onChange={setCron}
                isDisabled={save.isPending}
              />
            </label>
            <label className={label}>
              Time zone
              <TextField
                aria-label="Time zone"
                value={timezone}
                onChange={setTimezone}
                isDisabled={save.isPending}
              />
            </label>
            <label className={label}>
              {actionLabel}
              <textarea
                className={editor}
                aria-label={actionLabel}
                value={action}
                onChange={(event) => setAction(event.target.value)}
                rows={routine.action.type === "runAgent" ? 6 : 4}
                spellCheck={routine.action.type === "runAgent"}
                disabled={save.isPending}
              />
            </label>
            <Select
              label="After run"
              selectedKey={autoArchiveSession ? "archive" : "show"}
              onSelectionChange={(key) => {
                if (key === null) return;
                setAutoArchiveSession(key === "archive");
              }}
              isDisabled={save.isPending}
            >
              <SelectItem id="show">Show session</SelectItem>
              <SelectItem id="archive">Auto archive session</SelectItem>
            </Select>
            {save.error && (
              <div className={error} role="alert">
                {save.error.message}
              </div>
            )}
            <div className={buttons}>
              <Button
                variant="quiet"
                onClick={onClose}
                isDisabled={save.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                isDisabled={
                  save.isPending ||
                  !name.trim() ||
                  !cron.trim() ||
                  !timezone.trim() ||
                  !action.trim()
                }
              >
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function describeSchedule(cron: string) {
  const described = errore.try({
    try: () => cronstrue.toString(cron),
    catch: (cause) => new ScheduleDescriptionError({ cron, cause }),
  });
  if (described instanceof Error) {
    // The server validated the schedule with Croner; show it as written.
    console.warn(described);
    return cron;
  }
  return described;
}

function formatTime(time: string, timezone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(time));
}

function formatRunTime(time: string, timezone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(time));
}

const styles = {
  pane: style({
    width: "100%",
    height: "100%",
    overflowY: "auto",
    backgroundColor: backgroundColor.app,
  }),
  content: style(
    flex({ direction: "column", gap: 8 }),
    spacing.padding({ all: 12 }),
    {
      width: "100%",
      maxWidth: "calc(72ch + 48px)",
      marginInline: "auto",
    },
  ),
  titleRow: style(
    flex({ alignItems: "center", justifyContent: "between", gap: 4 }),
  ),
  title: style(text({ size: "xl", fontWeight: 600, color: "highContrast" }), {
    margin: 0,
    minWidth: 0,
    overflowWrap: "anywhere",
  }),
  actions: style(flex({ alignItems: "center", gap: 2 }), { flexShrink: 0 }),
  details: style(text({ size: "sm", color: "lowContrast" }), {
    display: "grid",
    gridTemplateColumns: "max-content 1fr",
    columnGap: spacing.value(6),
    rowGap: spacing.value(1),
    margin: `${spacing.value(6)} 0 0`,
    "& > div": { display: "contents" },
    "& dd": {
      margin: 0,
      minWidth: 0,
      overflowWrap: "anywhere",
      color: "inherit",
    },
    "& dt": { fontWeight: 500 },
  }),
  section: style(flex({ direction: "column", gap: 3 })),
  sectionTitle: style(text({ size: "md", fontWeight: 600 }), { margin: 0 }),
  actionBody: style(text({ size: "sm", color: "highContrast" }), radius.md, {
    margin: 0,
    padding: spacing.value(4),
    backgroundColor: backgroundColor.element,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  }),
  editor: style(
    text({ size: "sm", color: "highContrast" }),
    radius.md,
    shadow.subtle,
    focusRing("&:focus-visible"),
    {
      width: "100%",
      minHeight: 112,
      padding: spacing.value(4),
      backgroundColor: backgroundColor.element,
      border: 0,
      resize: "vertical",
      fontFamily: "inherit",
    },
  ),
  overlay: style({
    position: "fixed",
    inset: 0,
    zIndex: 100,
    backgroundColor: "rgba(0, 0, 0, 0.35)",
    display: "grid",
    placeItems: "center",
    padding: "24px",
  }),
  modal: style(shadow.strong, radius.lg, spacing.padding({ all: 8 }), {
    width: "min(560px, 100%)",
    maxHeight: "min(720px, calc(100vh - 48px))",
    overflowY: "auto",
    backgroundColor: backgroundColor.app,
    "& [role='dialog']": { outline: "none" },
  }),
  form: style(flex({ direction: "column", gap: 6 })),
  modalHeading: style(text({ size: "md", fontWeight: 600 }), { margin: 0 }),
  label: style(text({ size: "sm" }), flex({ direction: "column", gap: 2 })),
  statusOption: style(flex({ alignItems: "center", gap: 2 })),
  modalButtons: style(flex({ justifyContent: "end", gap: 3 })),
  list: style({ listStyle: "none", padding: 0, margin: 0 }),
  runLink: style(flex({ direction: "column", gap: 1 }), radius.md, {
    padding: spacing.value(4),
    color: "inherit",
    textDecoration: "none",
    "&:hover": { backgroundColor: backgroundColor.elementHover },
  }),
  runInfo: style(text({ size: "xs", color: "lowContrast" })),
  error: style(text({ size: "sm", color: "highContrast" }), {
    color: "light-dark(#b42318, #ff9592)",
    overflowWrap: "anywhere",
  }),
  empty: style(text({ size: "sm", color: "lowContrast" }), { margin: 0 }),
};
