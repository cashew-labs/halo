import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import cronstrue from "cronstrue";
import * as errore from "errore";
import type {
  Automation,
  AutomationRunStatus,
  SessionSummary,
  WorkspaceSchema,
} from "@get-halo/client";
import { automationRunSelect } from "@get-halo/client";
import { Button } from "maui";
import { Pencil } from "maui/icons";
import { useStyles } from "purse-styles";
import { useApi } from "../api/ApiProvider.js";
import { useDatabaseQuery } from "../database/useDatabaseQuery.js";
import { useWorkspacePanes } from "../panes/WorkspacePanesProvider.js";
import { AutomationEditor } from "./AutomationEditor.js";
import { AutomationSample } from "./AutomationSample.js";
import { AutomationSource } from "./AutomationSource.js";
import { automationStyles as styles } from "./automationStyles.js";

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
} satisfies Record<AutomationRunStatus, string>;

export function AutomationsPane() {
  const automations = useDatabaseQuery({
    collection: "automations",
    orderBy: { createdAt: "asc", id: "asc" },
  });
  const workspace = useWorkspacePanes();
  const [creating, setCreating] = useState(false);
  const pane = useStyles(styles.pane);
  const content = useStyles(styles.content);
  const titleRow = useStyles(styles.titleRow);
  const title = useStyles(styles.title);
  const list = useStyles(styles.list);
  const link = useStyles(styles.runLink);
  const info = useStyles(styles.runInfo);
  return (
    <div className={pane} role="region" aria-label="Automations">
      <div className={content}>
        <header className={titleRow}>
          <h2 className={title}>Automations</h2>
          <Button onClick={() => setCreating(true)}>New automation</Button>
        </header>
        <p>
          Run an agent or script on a schedule, when email arrives, or when a
          service calls your private webhook. You can also ask Halo to set one
          up.
        </p>
        {automations === undefined ? (
          <p>Loading automations…</p>
        ) : automations.length === 0 ? (
          <p>No automations yet.</p>
        ) : (
          <ul className={list}>
            {automations.map((automation) => (
              <li key={automation.id}>
                <a
                  className={link}
                  href={`/automations/${encodeURIComponent(automation.id)}`}
                  onClick={(event) => {
                    event.preventDefault();
                    workspace.open({
                      path: `/automations/${encodeURIComponent(automation.id)}`,
                      newTab: event.metaKey || event.ctrlKey,
                    });
                  }}
                >
                  <span>{automation.name}</span>
                  <span className={info}>
                    {activationLabel(automation)} ·{" "}
                    {automation.enabled ? "Active" : "Paused"}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
        {creating && (
          <AutomationEditor
            onClose={() => setCreating(false)}
            onSaved={(automation) => {
              setCreating(false);
              workspace.open({
                path: `/automations/${encodeURIComponent(automation.id)}`,
              });
            }}
          />
        )}
      </div>
    </div>
  );
}

export function AutomationPane({
  automationId,
  sessions,
}: {
  automationId: string;
  sessions: SessionSummary[];
}) {
  const automations = useDatabaseQuery({
    collection: "automations",
    where: { id: automationId },
  });
  const empty = useStyles(styles.empty);
  const automation = automations?.find((item) => item.id === automationId);
  if (automations === undefined)
    return <div className={empty}>Loading automation…</div>;
  if (automation === undefined)
    return (
      <div className={empty} role="status">
        This automation was removed. Sessions from its runs are still in the
        sidebar.
      </div>
    );
  return (
    <AutomationView
      key={automation.id}
      automation={automation}
      sessions={sessions}
    />
  );
}

function AutomationView({
  automation,
  sessions,
}: {
  automation: WorkspaceSchema["automations"];
  sessions: SessionSummary[];
}) {
  const api = useApi();
  const workspace = useWorkspacePanes();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const sourceKey = [
    "automationSource",
    automation.id,
    automation.revision,
    automation.enabled,
  ];
  // Tandem has no not-equal predicate. Keep ordered metadata for this pane so
  // "Last run" still finds the last non-skipped run beyond the displayed 100.
  const runs = useDatabaseQuery({
    collection: "automationRuns",
    where: { automationId: automation.id },
    select: automationRunSelect,
    orderBy: { startedAt: "desc", sequence: "desc" },
  });
  const lastRun = runs?.find((run) => run.status !== "skipped");
  const source = useQuery({
    queryKey: sourceKey,
    queryFn: async () =>
      await api.automations.sourceStatus({ automationId: automation.id }),
    enabled: automation.activation.type === "trigger",
    refetchInterval: 5000,
  });
  const runNow = useMutation({
    mutationFn: async () =>
      await api.automations.runNow({ automationId: automation.id }),
  });
  const toggle = useMutation({
    mutationFn: async () =>
      await api.automations.setEnabled({
        automationId: automation.id,
        enabled: !automation.enabled,
      }),
  });
  const remove = useMutation({
    mutationFn: async () =>
      await api.automations.remove({ automationId: automation.id }),
    onSuccess: () => workspace.open({ path: "/automations" }),
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
  const timezone =
    automation.activation.type === "routine"
      ? automation.activation.schedule.timezone
      : new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const actionError =
    runNow.error ?? toggle.error ?? remove.error ?? source.error;
  const pending =
    source.data?.deliveries.filter(
      (delivery) => !runs?.some((run) => run.eventId === delivery.eventId),
    ) ?? [];
  const actionLabel =
    automation.action.type === "runAgent" ? "Agent prompt" : "Script";
  return (
    <div
      className={pane}
      role="region"
      aria-label={`Automation ${automation.name}`}
    >
      <div className={content}>
        <header>
          <div className={titleRow}>
            <h2 className={title}>{automation.name}</h2>
            <div className={actions}>
              <Button
                variant="quiet"
                aria-label="Edit automation"
                onClick={() => setEditing(true)}
              >
                <Pencil size="sm" aria-hidden="true" />
              </Button>
              <Button
                onClick={() => toggle.mutate()}
                isDisabled={toggle.isPending}
              >
                {automation.enabled ? "Pause" : "Resume"}
              </Button>
              <Button
                onClick={() => runNow.mutate()}
                isDisabled={runNow.isPending}
              >
                Run now
              </Button>
            </div>
          </div>
          <dl className={details}>
            <div>
              <dt>Activation</dt>
              <dd>{activationLabel(automation)}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{automation.enabled ? "Active" : "Paused"}</dd>
            </div>
            {automation.activation.type === "routine" && (
              <>
                <div>
                  <dt>Schedule</dt>
                  <dd>
                    {describeSchedule(automation.activation.schedule.cron)} (
                    {timezone})
                  </dd>
                </div>
                <div>
                  <dt>Next run</dt>
                  <dd>
                    {automation.nextRunAt === undefined
                      ? "Paused"
                      : formatTime(automation.nextRunAt, timezone)}
                  </dd>
                </div>
              </>
            )}
            {automation.activation.type === "trigger" &&
              automation.activation.trigger.type === "gmail" && (
                <>
                  <div>
                    <dt>From</dt>
                    <dd>{automation.activation.trigger.from ?? "Anyone"}</dd>
                  </div>
                  <div>
                    <dt>Subject contains</dt>
                    <dd>
                      {automation.activation.trigger.subjectContains ??
                        "Any subject"}
                    </dd>
                  </div>
                </>
              )}
            <div>
              <dt>Last run</dt>
              <dd>
                {lastRun === undefined
                  ? "Never"
                  : `${statusLabels[lastRun.status]} · ${formatTime(lastRun.startedAt, timezone)}`}
              </dd>
            </div>
            <div>
              <dt>After run</dt>
              <dd>
                {automation.autoArchiveSession
                  ? "Auto archive session"
                  : "Show session"}
              </dd>
            </div>
          </dl>
          {actionError && (
            <p className={errorText} role="alert">
              {actionError.message}
            </p>
          )}
        </header>
        {automation.activation.type === "trigger" &&
          (source.data === undefined ? (
            <p>Loading trigger source…</p>
          ) : (
            <AutomationSource
              key={`${automation.id}:${automation.revision}`}
              state={source.data}
            />
          ))}
        <section className={section} aria-label={actionLabel}>
          <h3 className={sectionTitle}>{actionLabel}</h3>
          <pre className={actionBody}>
            {automation.action.type === "runAgent"
              ? automation.action.prompt
              : automation.action.command}
          </pre>
        </section>
        <section className={section} aria-label="Run history">
          <h3 className={sectionTitle}>Run history</h3>
          {runs === undefined ? (
            <p>Loading runs…</p>
          ) : runs.length === 0 && pending.length === 0 ? (
            <p>No runs yet. Use Run now to test the saved action.</p>
          ) : (
            <ul className={list}>
              {pending.map((delivery) => (
                <li key={delivery.eventId} className={runLink}>
                  <span>{formatTime(delivery.occurredAt, timezone)}</span>
                  <span className={runInfo}>
                    {
                      {
                        pending: "Waiting for workspace",
                        delivered: "Accepted by workspace",
                        failed: "Delivery failed",
                        cancelled: "Cancelled",
                      }[delivery.status]
                    }{" "}
                    · {delivery.source === "gmail" ? "Gmail" : "Webhook"}
                  </span>
                  {delivery.error && (
                    <span className={errorText}>{delivery.error}</span>
                  )}
                </li>
              ))}
              {runs.slice(0, 100).map((run) => {
                const session = sessions.find(
                  (item) => item.sessionId === run.sessionId,
                );
                const body = (
                  <>
                    <span>
                      {session?.title ?? formatTime(run.startedAt, timezone)}
                    </span>
                    <span className={runInfo}>
                      {statusLabels[run.status]} ·{" "}
                      {
                        {
                          manual: "Run now",
                          schedule: "Scheduled",
                          event: "Triggered",
                        }[run.trigger]
                      }
                    </span>
                    {run.error && (
                      <span className={errorText}>{run.error}</span>
                    )}
                  </>
                );
                return (
                  <li key={run.id}>
                    {run.sessionId === undefined ? (
                      <div className={runLink}>{body}</div>
                    ) : (
                      <a
                        className={runLink}
                        href={`/sessions/${encodeURIComponent(run.sessionId)}`}
                        onClick={(event) => {
                          event.preventDefault();
                          workspace.open({
                            path: `/sessions/${encodeURIComponent(run.sessionId!)}`,
                            newTab: event.metaKey || event.ctrlKey,
                          });
                        }}
                      >
                        {body}
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        {automation.activation.type === "trigger" && (
          <AutomationSample automationId={automation.id} />
        )}
        <footer>
          <Button variant="quiet" onClick={() => setRemoving(true)}>
            Remove automation
          </Button>
          {removing && (
            <div role="group" aria-label="Remove automation">
              <p>
                Remove this automation and cancel queued runs? Existing run
                sessions are kept.
              </p>
              <div className={actions}>
                <Button
                  onClick={() => remove.mutate()}
                  isDisabled={remove.isPending}
                >
                  Remove
                </Button>
                <Button variant="quiet" onClick={() => setRemoving(false)}>
                  Keep automation
                </Button>
              </div>
            </div>
          )}
        </footer>
      </div>
      {editing && (
        <AutomationEditor
          automation={{
            ...automation,
            createdAt: new Date(automation.createdAt).toISOString(),
            updatedAt: new Date(automation.updatedAt).toISOString(),
            nextRunAt:
              automation.nextRunAt === undefined
                ? undefined
                : new Date(automation.nextRunAt).toISOString(),
          }}
          onClose={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      )}
    </div>
  );
}

function activationLabel(automation: Pick<Automation, "activation">) {
  return automation.activation.type === "routine"
    ? "Routine"
    : automation.activation.trigger.type === "gmail"
      ? "Trigger · Gmail"
      : "Trigger · Webhook";
}
function describeSchedule(cron: string) {
  const described = errore.try({
    try: () => cronstrue.toString(cron),
    catch: (cause) => new ScheduleDescriptionError({ cron, cause }),
  });
  if (described instanceof Error) return cron;
  return described;
}
function formatTime(time: string | number, timezone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(time));
}
