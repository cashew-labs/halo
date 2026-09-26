import { useState } from "react";
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
  RoutineRun,
  RoutineRunStatus,
  SessionSummary,
} from "@get-halo/client";
import {
  Button,
  Select,
  SelectItem,
  backgroundColor,
  flex,
  spacing,
  text,
} from "maui";
import { Pause, Play } from "maui/icons";
import { style, useStyles } from "purse-styles";
import { useApi } from "../api/ApiProvider.js";
import { useRoutines } from "../api/WorkspaceUpdatesProvider.js";
import { AgentPane } from "./agent/AgentPane.js";

class ScheduleDescriptionError extends errore.createTaggedError({
  name: "ScheduleDescriptionError",
  message: "Could not describe the schedule '$cron'",
}) {}

const statusLabels = {
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
  return <RoutineView routine={routine} sessions={sessions} />;
}

function RoutineView({
  routine,
  sessions,
}: {
  routine: Routine;
  sessions: SessionSummary[];
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<string>();
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
  const setEnabled = useMutation({
    mutationFn: async (enabled: boolean) =>
      await api.routines.setEnabled({ routineId: routine.id, enabled }),
  });
  const runNow = useMutation({
    mutationFn: async () =>
      await api.routines.runNow({ routineId: routine.id }),
    onSuccess: async (run) => {
      setSelectedRunId(run.id);
      await queryClient.invalidateQueries({ queryKey: runsQueryKey });
    },
  });
  const pane = useStyles(styles.pane);
  const header = useStyles(styles.header);
  const titleRow = useStyles(styles.titleRow);
  const title = useStyles(styles.title);
  const actions = useStyles(styles.actions);
  const details = useStyles(styles.details);
  const errorText = useStyles(styles.error);
  const picker = useStyles(styles.picker);
  const session = useStyles(styles.session);
  const empty = useStyles(styles.empty);
  const note = useStyles(styles.note);
  const selected =
    runs.data?.find((run) => run.id === selectedRunId) ?? runs.data?.[0];
  const actionError = setEnabled.error ?? runNow.error ?? runs.error;

  return (
    <div className={pane} role="region" aria-label={`Routine ${routine.name}`}>
      <header className={header}>
        <div className={titleRow}>
          <h2 className={title}>{routine.name}</h2>
          <div className={actions}>
            <Button
              variant="quiet"
              isDisabled={setEnabled.isPending}
              onClick={() => setEnabled.mutate(!routine.enabled)}
            >
              {routine.enabled ? (
                <Pause size="sm" aria-hidden="true" />
              ) : (
                <Play size="sm" aria-hidden="true" />
              )}
              {routine.enabled ? "Pause" : "Resume"}
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
            <dt>Action</dt>
            <dd>
              {routine.action.type === "runAgent"
                ? "Agent prompt"
                : `Script: ${routine.action.command}`}
            </dd>
          </div>
        </dl>
        {actionError === null ? undefined : (
          <div className={errorText} role="alert">
            {actionError.message}
          </div>
        )}
        {runs.data === undefined || runs.data.length === 0 ? undefined : (
          <div className={picker}>
            <Select
              label="Run"
              selectedKey={selected?.id}
              onSelectionChange={(key) => setSelectedRunId(String(key))}
              items={runs.data}
            >
              {(run) => (
                <SelectItem id={run.id} textValue={runLabel(run, routine)}>
                  {runLabel(run, routine)}
                </SelectItem>
              )}
            </Select>
          </div>
        )}
      </header>
      <RunSession
        run={selected}
        sessions={sessions}
        className={session}
        emptyClassName={empty}
        errorClassName={errorText}
        noteClassName={note}
      />
    </div>
  );
}

function RunSession({
  run,
  sessions,
  className,
  emptyClassName,
  errorClassName,
  noteClassName,
}: {
  run: RoutineRun | undefined;
  sessions: SessionSummary[];
  className: string;
  emptyClassName: string;
  errorClassName: string;
  noteClassName: string;
}) {
  if (run === undefined)
    return (
      <div className={emptyClassName}>
        No runs yet. Use Run now to start one.
      </div>
    );
  return (
    <>
      {run.error === undefined ? undefined : (
        <div
          className={run.status === "failed" ? errorClassName : noteClassName}
          role="status"
        >
          {statusLabels[run.status]}: {run.error}
        </div>
      )}
      {run.sessionId === undefined ? (
        <div className={emptyClassName}>This run did not start a session.</div>
      ) : (
        <div className={className}>
          <AgentPane
            key={run.sessionId}
            sessionId={run.sessionId}
            sessions={sessions}
          />
        </div>
      )}
    </>
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

function runLabel(run: RoutineRun, routine: Routine) {
  return [
    formatTime(run.scheduledFor, routine.timezone),
    statusLabels[run.status],
    run.trigger === "manual" ? "Run now" : "Scheduled",
  ].join(" · ");
}

const styles = {
  pane: style(flex({ direction: "column" }), {
    width: "100%",
    height: "100%",
    minWidth: 0,
    minHeight: 0,
    backgroundColor: backgroundColor.app,
  }),
  header: style(
    flex({ direction: "column", gap: 3 }),
    spacing.padding({ x: 12, top: 12, bottom: 3 }),
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
    margin: 0,
    "& > div": { display: "contents" },
    "& dd": {
      margin: 0,
      minWidth: 0,
      overflowWrap: "anywhere",
      color: "inherit",
    },
    "& dt": { fontWeight: 500 },
  }),
  error: style(text({ size: "sm", color: "highContrast" }), {
    color: "light-dark(#b42318, #ff9592)",
    width: "100%",
    maxWidth: "calc(72ch + 48px)",
    marginInline: "auto",
    paddingInline: spacing.value(12),
    overflowWrap: "anywhere",
  }),
  note: style(text({ size: "sm", color: "lowContrast" }), {
    width: "100%",
    maxWidth: "calc(72ch + 48px)",
    marginInline: "auto",
    paddingInline: spacing.value(12),
    overflowWrap: "anywhere",
  }),
  picker: style({ maxWidth: "48ch" }),
  session: style(flex({}), { flex: "1 1 auto", minHeight: 0, minWidth: 0 }),
  empty: style(text({ size: "sm", color: "lowContrast" }), {
    padding: spacing.value(12),
    textAlign: "center",
  }),
};
