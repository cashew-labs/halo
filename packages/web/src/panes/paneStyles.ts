import {
  backgroundColor,
  colors,
  flex,
  flexItem,
  focusRing,
  radius,
  text,
} from "maui";
import { style, useInjectGlobalStyles, useStyles } from "purse-styles";

export const tabBarHeight = 42;

const iconButton = style(radius.sm, {
  border: 0,
  backgroundColor: "transparent",
  font: "inherit",
  cursor: "default",
  WebkitAppRegion: "no-drag",
  display: "grid",
  placeItems: "center",
  flexShrink: 0,
  alignSelf: "center",
});

export const paneStyles = {
  workspace: style(
    focusRing("& button:focus-visible, & [role=separator]:focus-visible"),
    text({ size: "sm" }),
    {
      position: "relative",
      minWidth: 0,
      minHeight: 0,
      overflow: "hidden",
      backgroundColor: backgroundColor.app,
      "& button": { color: "inherit" },
    },
  ),
  pane: style({
    position: "absolute",
    overflow: "hidden",
    backgroundColor: backgroundColor.app,
  }),
  tabBar: style(flex({ alignItems: "stretch" }), {
    height: tabBarHeight,
    paddingTop: 6,
    paddingInline: 8,
    backgroundColor: backgroundColor.element,
    boxShadow: `inset 0 -1px ${colors.gray[6]}`,
    WebkitAppRegion: "drag",
  }),
  tabs: style(flex(), {
    minWidth: 0,
    padding: "1px 6px 0",
    overflowX: "auto",
    scrollbarWidth: "none",
  }),
  tab: style({
    position: "relative",
    display: "flex",
    flex: "1 1 160px",
    width: 160,
    minWidth: 80,
    maxWidth: 160,
    padding: "1px 3px 4px",
    borderRadius: "6px 6px 0 0",
    color: colors.gray[11],
    WebkitAppRegion: "no-drag",
    "&[data-selected='true']": {
      zIndex: 1,
      backgroundColor: backgroundColor.app,
      boxShadow: `0 0 0 1px ${colors.gray[6]}`,
      color: "inherit",
    },
    // The active outline curves into the tab strip's bottom edge.
    "&[data-selected='true']::before, &[data-selected='true']::after": {
      content: "''",
      position: "absolute",
      bottom: 0,
      width: 12,
      height: 12,
      borderRadius: "50%",
      pointerEvents: "none",
      boxShadow: `inset 0 0 0 1px ${colors.gray[6]}, 0 0 0 12px ${backgroundColor.app}`,
    },
    "&[data-selected='true']::before": {
      left: -12,
      clipPath: "inset(50% -6px 0 50%)",
    },
    "&[data-selected='true']::after": {
      right: -12,
      clipPath: "inset(50% 50% 0 -6px)",
    },
    "& button": {
      border: 0,
      backgroundColor: "transparent",
      font: "inherit",
      cursor: "default",
      WebkitAppRegion: "no-drag",
    },
    "& [role='tab']": {
      minWidth: 0,
      flex: 1,
      height: "100%",
      padding: "0 4px 0 6px",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textAlign: "left",
      borderRadius: 4,
    },
    '&:not([data-selected="true"]):not(:has(+ [data-selected="true"])):not(:last-child) [data-pane-tab-inner]::after':
      {
        content: "''",
        position: "absolute",
        right: 0,
        width: 1,
        height: 20,
        backgroundColor: colors.gray[6],
      },
  }),
  tabInner: style(flex({ alignItems: "center" }), radius.sm, {
    minWidth: 0,
    width: "100%",
    paddingRight: 3,
  }),
  close: style(iconButton, {
    width: 20,
    height: 20,
    padding: 2,
    "& svg": { opacity: 0.7 },
  }),
  add: style(iconButton, {
    width: 28,
    height: 28,
    margin: "0 4px 4px",
  }),
  windowDrag: style(flexItem({ size: "fill" }), {
    minWidth: 12,
    WebkitAppRegion: "drag",
  }),
  content: style(flex(), {
    position: "absolute",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    "&[hidden]": { display: "none" },
    "& > main": { flex: 1, height: "100%" },
  }),
  divider: style({
    position: "absolute",
    zIndex: 4,
    touchAction: "none",
    outline: "none",
    "&::after": {
      content: "''",
      position: "absolute",
      backgroundColor: colors.gray[6],
    },
    "&[data-axis='horizontal']": { cursor: "col-resize" },
    "&[data-axis='vertical']": { cursor: "row-resize" },
    "&[data-axis='horizontal']::after": {
      top: 0,
      bottom: 0,
      left: 2,
      width: 1,
    },
    "&[data-axis='vertical']::after": {
      left: 0,
      right: 0,
      top: 2,
      height: 1,
    },
    "&:hover::after, &:focus-visible::after": {
      backgroundColor: colors.accent[9],
    },
  }),
  dropShield: style({
    position: "absolute",
    inset: 0,
    zIndex: 5,
  }),
  dropPreview: style({
    position: "absolute",
    zIndex: 6,
    pointerEvents: "none",
    display: "grid",
    placeItems: "center",
    padding: 8,
    border: `2px solid ${colors.accent[9]}`,
    backgroundColor: colors.accentAlpha[4],
    "& span": {
      padding: "6px 10px",
      borderRadius: 6,
      backgroundColor: backgroundColor.app,
      whiteSpace: "nowrap",
    },
  }),
};

/** purse-styles cannot nest `&:hover` inside `@media`, so hover chrome is injected. */
function usePaneHoverChrome() {
  useInjectGlobalStyles(
    '[data-testid="pane-workspace"] [data-pane-tab]:not([data-selected="true"]):not(:hover):not(:focus-within) [data-pane-close]',
    { "@media (hover: hover)": { display: "none" } },
    [],
  );
  useInjectGlobalStyles(
    '[data-testid="pane-workspace"] [data-pane-tab]:not([data-selected="true"]):hover [data-pane-tab-inner], [data-testid="pane-workspace"] [data-pane-tab][data-selected="true"] [data-pane-close]:hover, [data-testid="pane-workspace"] [data-pane-add]:hover',
    { "@media (hover: hover)": { backgroundColor: colors.gray[4] } },
    [],
  );
  useInjectGlobalStyles(
    '[data-testid="pane-workspace"] [data-pane-close]:hover svg',
    { "@media (hover: hover)": { opacity: 1 } },
    [],
  );
}

export function usePaneStyles() {
  usePaneHoverChrome();
  return {
    workspace: useStyles(paneStyles.workspace),
    pane: useStyles(paneStyles.pane),
    tabBar: useStyles(paneStyles.tabBar),
    tabs: useStyles(paneStyles.tabs),
    tab: useStyles(paneStyles.tab),
    tabInner: useStyles(paneStyles.tabInner),
    close: useStyles(paneStyles.close),
    add: useStyles(paneStyles.add),
    windowDrag: useStyles(paneStyles.windowDrag),
    content: useStyles(paneStyles.content),
    divider: useStyles(paneStyles.divider),
    dropShield: useStyles(paneStyles.dropShield),
    dropPreview: useStyles(paneStyles.dropPreview),
  };
}
