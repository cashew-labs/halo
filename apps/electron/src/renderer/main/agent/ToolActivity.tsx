import { useEffect, useEffectEvent, useState } from "react";
import {
  ChevronRightLarge,
  Thinking,
  colors,
  flex,
  motionDurationMs,
  motionEasing,
  spacing,
  text,
} from "maui";
import { style, useStyles } from "purse-styles";
import {
  summarizeToolActivities,
  type SessionViewPart,
  type ToolPart,
} from "./sessionView.ts";
import { ToolCall } from "./ToolCall.tsx";
import { useWorkspaceQuery } from "../../api/ApiProvider.tsx";

type ToolActivityPart = Extract<SessionViewPart, { kind: "toolActivity" }>;

const thinkingSize = "0.6em";
const chevronSize = "0.85em";
const markSlot = "0.85em";
const transitionRemovalDelayMs = motionDurationMs + 16;

export function ToolActivity({ part }: { part: ToolActivityPart }) {
  const [expanded, setExpanded] = useState(false);
  const calls = part.calls;
  const workspace = useWorkspaceQuery().data;
  const workspaceRoot = workspace?.workspaceRoot;
  const summary = summarizeToolActivities({
    calls,
    workspaceRoot,
    live: part.live,
  });
  const activityClassName = useStyles(styles.activity);
  const summaryClassName = useStyles(styles.summary);
  const thinkingClassName = useStyles(styles.thinking);
  const markClassName = useStyles(styles.mark);
  const activeCommandsClassName = useStyles(styles.activeCommands);
  const activeCommandClassName = useStyles(styles.activeCommand);
  const interactive = calls.length > 0;
  const visibleCalls = expanded ? calls : [];
  const completedLabel = joinSummary(summary.completed);
  if (completedLabel === undefined && !part.live) return undefined;
  const headerLabel = completedLabel === undefined ? "Working" : completedLabel;
  const activeLabels = summary.active;

  return (
    <div className={activityClassName} aria-label="Tool activity">
      {interactive ? (
        <button
          type="button"
          className={summaryClassName}
          aria-label={headerLabel}
          aria-expanded={expanded}
          data-active={part.live ? "" : undefined}
          onClick={() => setExpanded(!expanded)}
        >
          <span className={markClassName}>
            {part.live ? (
              <Thinking
                size={thinkingSize}
                variant="muted"
                aria-label="Working"
              />
            ) : undefined}
            <span role="img" aria-label="Expand tool activity">
              <ChevronRightLarge width={chevronSize} height={chevronSize} />
            </span>
          </span>
          {headerLabel}
        </button>
      ) : (
        <div className={thinkingClassName}>
          {part.live ? (
            <span className={markClassName}>
              <Thinking
                size={thinkingSize}
                variant="muted"
                aria-label="Working"
              />
            </span>
          ) : undefined}
          {headerLabel}
        </div>
      )}
      {activeLabels.length === 0 ? undefined : (
        <div className={activeCommandsClassName} aria-label="Active commands">
          {activeLabels.map((label) => (
            <div key={label} className={activeCommandClassName}>
              {label}
            </div>
          ))}
        </div>
      )}
      <AnimatedToolCalls calls={visibleCalls} />
    </div>
  );
}

function joinSummary(chunks: readonly string[]): string | undefined {
  const first = chunks[0];
  if (first === undefined) return undefined;
  const capitalized = `${first.charAt(0).toUpperCase()}${first.slice(1)}`;
  const rest = chunks.slice(1);
  const last = rest.at(-1);
  if (last === undefined) return capitalized;
  if (rest.length === 1) return `${capitalized} and ${last}`;
  return `${capitalized}, ${rest.slice(0, -1).join(", ")}, and ${last}`;
}

function AnimatedToolCalls({ calls }: { calls: ToolPart[] }) {
  const callIds = JSON.stringify(calls.map((call) => call.id));
  const [previousCallIds, setPreviousCallIds] = useState(callIds);
  const [retainedCalls, setRetainedCalls] = useState(calls);
  const transitionClassName = useStyles(styles.callsTransition);
  const callsClassName = useStyles(styles.calls);
  const callClassName = useStyles(styles.call);
  const callContentClassName = useStyles(styles.callContent);

  if (callIds !== previousCallIds) {
    setPreviousCallIds(callIds);
    setRetainedCalls((currentCalls) => {
      const retainedIds = new Set(currentCalls.map((call) => call.id));
      return [
        ...currentCalls,
        ...calls.filter((call) => !retainedIds.has(call.id)),
      ];
    });
  }

  const finishTransition = useEffectEvent((transitionCallIds: string) => {
    const currentCallIds = JSON.stringify(calls.map((call) => call.id));
    if (currentCallIds !== transitionCallIds) return;
    const visibleIds = new Set(calls.map((call) => call.id));
    setRetainedCalls((currentCalls) =>
      currentCalls.filter((call) => visibleIds.has(call.id)),
    );
  });

  useEffect(() => {
    const timeout = window.setTimeout(
      () => finishTransition(callIds),
      transitionRemovalDelayMs,
    );
    return () => window.clearTimeout(timeout);
  }, [callIds]);

  if (retainedCalls.length === 0) return undefined;

  const visibleCalls = new Map(calls.map((call) => [call.id, call]));
  return (
    <div
      className={transitionClassName}
      data-visible={calls.length > 0 ? "" : undefined}
    >
      <div className={callsClassName}>
        {retainedCalls.map((retainedCall) => {
          const visibleCall = visibleCalls.get(retainedCall.id);
          return (
            <div
              key={retainedCall.id}
              className={callClassName}
              data-visible={visibleCall === undefined ? undefined : ""}
            >
              <div className={callContentClassName}>
                <ToolCall
                  part={visibleCall === undefined ? retainedCall : visibleCall}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const summaryRow = style(
  text({ size: "md", fontWeight: 400, color: "lowContrast" }),
  flex({ align: "center", gap: 4 }),
  {
    overflow: "visible",
    color: colors.gray[11],
  },
);

const nestedIndent = {
  marginLeft: spacing.value(6),
  paddingLeft: spacing.value(4),
} as const;

const styles = {
  activity: style(flex({ direction: "column" }), {
    minWidth: 0,
  }),
  thinking: summaryRow,
  mark: style({
    display: "inline-flex",
    width: markSlot,
    height: markSlot,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  }),
  summary: style(summaryRow, {
    width: "fit-content",
    maxWidth: "100%",
    minWidth: 0,
    padding: 0,
    border: "none",
    margin: 0,
    appearance: "none",
    background: "transparent",
    justifyContent: "flex-start",
    textAlign: "left",
    cursor: "pointer",
    "& [aria-label='Expand tool activity']": { display: "none" },
    "& [aria-label='Expand tool activity'] svg": {
      transition: `transform ${String(motionDurationMs)}ms ${motionEasing}`,
      transformOrigin: "center",
    },
    "&:hover, &:focus-visible": {
      color: colors.gray[12],
      background: "transparent",
    },
    "&:hover [aria-label='Working'], &:focus-visible [aria-label='Working']": {
      display: "none",
    },
    "&:hover [aria-label='Expand tool activity'], &:focus-visible [aria-label='Expand tool activity']":
      {
        display: "inline-flex",
      },
    "&:not([data-active]) [aria-label='Expand tool activity']": {
      display: "inline-flex",
    },
    "&[aria-expanded='true']": {
      color: colors.gray[12],
      background: "transparent",
    },
    "&[aria-expanded='true'] [aria-label='Expand tool activity'] svg": {
      transform: "rotate(90deg)",
    },
    "&:focus": {
      outline: "none",
    },
  }),
  callsTransition: style({
    display: "grid",
    gridTemplateRows: "minmax(0, 0fr)",
    minWidth: 0,
    marginTop: 0,
    opacity: 0,
    transition: `grid-template-rows ${String(motionDurationMs)}ms ${motionEasing}, margin-top ${String(motionDurationMs)}ms ${motionEasing}, opacity ${String(motionDurationMs)}ms ${motionEasing}`,
    "&[data-visible]": {
      gridTemplateRows: "minmax(0, 1fr)",
      marginTop: spacing.value(3),
      opacity: 1,
    },
    "@starting-style": {
      gridTemplateRows: "minmax(0, 0fr)",
      marginTop: 0,
      opacity: 0,
    },
  }),
  activeCommands: style(flex({ direction: "column", gap: 2 }), nestedIndent, {
    minWidth: 0,
    marginTop: spacing.value(3),
  }),
  activeCommand: style(
    text({ size: "md", fontWeight: 400, color: "lowContrast" }),
    {
      minWidth: 0,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      color: colors.gray[11],
    },
  ),
  calls: style(flex({ direction: "column", gap: 2 }), nestedIndent, {
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
  }),
  call: style({
    display: "grid",
    gridTemplateRows: "minmax(0, 0fr)",
    minWidth: 0,
    opacity: 0,
    transform: `translateY(-${spacing.value(1)})`,
    transition: `grid-template-rows ${String(motionDurationMs)}ms ${motionEasing}, opacity ${String(motionDurationMs)}ms ${motionEasing}, transform ${String(motionDurationMs)}ms ${motionEasing}`,
    "&[data-visible]": {
      gridTemplateRows: "minmax(0, 1fr)",
      opacity: 1,
      transform: "translateY(0)",
    },
    "@starting-style": {
      gridTemplateRows: "minmax(0, 0fr)",
      opacity: 0,
      transform: `translateY(-${spacing.value(1)})`,
    },
  }),
  callContent: style({
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
  }),
};
