import {
  backgroundColor,
  colors,
  flex,
  flexItem,
  focusRing,
  spacing,
  text,
} from "maui";
import { style, useStyles } from "purse-styles";

export const tabBarHeight = 42;

export const paneStyles = {
  workspace: style(
    focusRing("& [role=separator]:focus-visible"),
    text({ size: "sm" }),
    {
      position: "relative",
      minWidth: 0,
      minHeight: 0,
      overflow: "hidden",
      backgroundColor: backgroundColor.app,
    },
  ),
  pane: style({
    position: "absolute",
    overflow: "hidden",
    backgroundColor: backgroundColor.app,
  }),
  tabBar: style(flex({ alignItems: "center" }), {
    height: tabBarHeight,
    paddingInline: 8,
    backgroundColor: backgroundColor.app,
    borderBottom: `1px solid ${colors.gray[6]}`,
    WebkitAppRegion: "drag",
  }),
  tabs: style({
    display: "flex",
    height: "100%",
    minWidth: 0,
    WebkitAppRegion: "no-drag",
  }),
  nativeTabBar: style({
    height: "100%",
    paddingInline: 0,
    borderBottom: 0,
    // Keep tab shadows inside the scroller without shifting the tab labels.
    "& [role=toolbar]": {
      paddingInline: spacing.value(3),
      marginInline: `calc(${spacing.value(3)} * -1)`,
    },
  }),
  add: style({
    width: 28,
    height: 28,
    marginInline: 4,
    flexShrink: 0,
    WebkitAppRegion: "no-drag",
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

export function usePaneStyles() {
  return {
    workspace: useStyles(paneStyles.workspace),
    pane: useStyles(paneStyles.pane),
    tabBar: useStyles(paneStyles.tabBar),
    tabs: useStyles(paneStyles.tabs),
    nativeTabBar: useStyles(paneStyles.nativeTabBar),
    add: useStyles(paneStyles.add),
    windowDrag: useStyles(paneStyles.windowDrag),
    content: useStyles(paneStyles.content),
    divider: useStyles(paneStyles.divider),
    dropShield: useStyles(paneStyles.dropShield),
    dropPreview: useStyles(paneStyles.dropPreview),
  };
}
