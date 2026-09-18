import type { SessionSummary } from "@get-halo/client";
import { colors } from "maui";
import { style, useStyles } from "purse-styles";
import { useSessionReadState } from "../main/agent/useSessionReadState.js";
import "./sessionActivity.css";

export function SessionActivity({ session }: { session: SessionSummary }) {
  const { seenResultId } = useSessionReadState(session.sessionId);
  const indicator = useStyles(indicatorStyle);
  const spinner = useStyles(spinnerStyle);
  const dot = useStyles(dotStyle);
  const unread =
    session.latestResultId !== undefined &&
    session.latestResultId !== seenResultId;
  if (!session.isRunning && !unread) return undefined;
  const label = session.isRunning ? "Agent is working" : "Unread result";
  return (
    <span className={indicator} role="img" aria-label={label} title={label}>
      <span aria-hidden="true" className={session.isRunning ? spinner : dot} />
    </span>
  );
}

const indicatorStyle = style({
  display: "grid",
  placeItems: "center",
  width: "16px",
  height: "16px",
});

const spinnerStyle = style({
  width: "12px",
  height: "12px",
  borderRadius: "50%",
  border: `1.5px solid ${colors.gray[8]}`,
  borderTopColor: colors.gray[11],
  borderRightColor: colors.gray[11],
  animation: "sessionActivitySpin 800ms linear infinite",
  "@media (prefers-reduced-motion: reduce)": { animation: "none" },
});

const dotStyle = style({
  width: "8px",
  height: "8px",
  borderRadius: "50%",
  backgroundColor: colors.blue[9],
});
