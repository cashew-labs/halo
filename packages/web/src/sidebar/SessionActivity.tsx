import { isThreadUnread, type SessionSummary } from "@get-halo/client";
import { Thinking, colors, motion } from "maui";
import { style, useStyles } from "purse-styles";

export function SessionActivity({ session }: { session: SessionSummary }) {
  const indicator = useStyles(indicatorStyle);
  const streamingStatus = useStyles(
    statusLayerStyle,
    ...(session.isRunning ? [visibleStatusStyle] : []),
  );
  const isUnread = !session.isRunning && isThreadUnread(session);
  const unreadStatus = useStyles(
    statusLayerStyle,
    ...(isUnread ? [visibleStatusStyle] : []),
  );
  const dot = useStyles(dotStyle);
  return (
    <span className={indicator}>
      <span className={streamingStatus} aria-hidden={!session.isRunning}>
        <Thinking size="0.7em" variant="muted" aria-label="Agent is working" />
      </span>
      <span
        className={unreadStatus}
        role="img"
        aria-label="Unread result"
        aria-hidden={!isUnread}
        title="Unread result"
      >
        <span aria-hidden="true" className={dot} />
      </span>
    </span>
  );
}

const indicatorStyle = style({
  display: "grid",
  placeItems: "center",
  flexShrink: 0,
  width: "16px",
  height: "16px",
});

const statusLayerStyle = style(motion.standard("opacity"), {
  gridArea: "1 / 1",
  display: "grid",
  placeItems: "center",
  width: "16px",
  height: "16px",
  opacity: 0,
  pointerEvents: "none",
});

const visibleStatusStyle = style({ opacity: 1 });

const dotStyle = style({
  display: "block",
  width: "6px",
  height: "6px",
  borderRadius: "50%",
  backgroundColor: colors.accent[9],
});
