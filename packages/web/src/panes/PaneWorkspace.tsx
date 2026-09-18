import { useRef, type CSSProperties } from "react";
import { Router } from "wouter";
import type { SessionSummary } from "@get-halo/client";
import { backgroundColor, colors, focusRing, text } from "maui";
import { Plus, Close } from "maui/icons";
import { style, useStyles } from "purse-styles";
import { MainPane } from "../main/MainPane.js";
import { paneLayout, type Rect, type WorkspaceTab } from "./WorkspacePanes.js";
import {
  TabRouteContext,
  usePaneLocation,
  usePaneState,
  useWorkspacePanes,
} from "./WorkspacePanesProvider.js";
import "./paneWorkspace.css";

function bounds(rect: Rect): CSSProperties {
  return {
    left: `${rect.x}%`,
    top: `${rect.y}%`,
    width: `${rect.width}%`,
    height: `${rect.height}%`,
  };
}
function tabTitle(tab: WorkspaceTab, sessions: SessionSummary[]) {
  if (tab.path.startsWith("/draft/")) return "New session";
  if (tab.path.startsWith("/sessions/")) {
    const id = tab.path.slice(10);
    return sessions.find((session) => session.sessionId === id)?.title ?? id;
  }
  return decodeURIComponent(tab.path.split("/").at(-1) ?? tab.path);
}

export function PaneWorkspace({ sessions }: { sessions: SessionSummary[] }) {
  const workspace = useWorkspacePanes();
  const state = usePaneState();
  const { leaves, dividers } = paneLayout(state.root);
  const root = useRef<HTMLDivElement>(null);
  const className = useStyles(workspaceStyle);

  return (
    <div ref={root} className={`${className} paneWorkspace`}>
      {leaves.map(({ pane, rect }, index) => (
        <section
          key={pane.id}
          className="workspacePane"
          style={bounds(rect)}
          data-pane-id={pane.id}
          data-active={state.activePaneId === pane.id}
          aria-label={`Pane ${index + 1}`}
          onPointerDownCapture={() => workspace.select(pane.id)}
        >
          <div className="paneTabBar">
            <div
              role="tablist"
              aria-label={`Pane ${index + 1} tabs`}
              className="paneTabs"
            >
              {pane.tabs.map((tab, tabIndex) => (
                <div
                  key={tab.id}
                  className="paneTab"
                  data-selected={pane.activeTabId === tab.id}
                >
                  <button
                    type="button"
                    role="tab"
                    id={`tab-${tab.id}`}
                    aria-controls={`panel-${tab.id}`}
                    aria-selected={pane.activeTabId === tab.id}
                    tabIndex={pane.activeTabId === tab.id ? 0 : -1}
                    title={
                      tab.path.startsWith("/files/")
                        ? decodeURIComponent(tab.path.slice(7))
                        : tabTitle(tab, sessions)
                    }
                    onClick={() => workspace.select(pane.id, tab.id)}
                    onKeyDown={(event) => {
                      const nextIndex =
                        event.key === "ArrowRight"
                          ? (tabIndex + 1) % pane.tabs.length
                          : event.key === "ArrowLeft"
                            ? (tabIndex + pane.tabs.length - 1) %
                              pane.tabs.length
                            : event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? pane.tabs.length - 1
                                : undefined;
                      if (nextIndex === undefined) return;
                      event.preventDefault();
                      const next = pane.tabs[nextIndex]!;
                      workspace.select(pane.id, next.id);
                      document.getElementById(`tab-${next.id}`)?.focus();
                    }}
                  >
                    {tabTitle(tab, sessions)}
                  </button>
                  <button
                    type="button"
                    className="paneClose"
                    aria-label={`Close ${tabTitle(tab, sessions)}`}
                    onClick={() => workspace.close(tab.id)}
                  >
                    <Close size="sm" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="paneAdd"
              aria-label="New tab"
              title="New tab"
              onClick={() => {
                workspace.select(pane.id);
                workspace.open({
                  path: `/draft/${crypto.randomUUID()}`,
                  newTab: true,
                });
              }}
            >
              <Plus size="sm" />
            </button>
          </div>
        </section>
      ))}
      {/* Flat, stable tab siblings keep editors and session drafts mounted across splits and moves. */}
      {leaves.flatMap(({ pane, rect }) =>
        pane.tabs.map((tab) => (
          <div
            key={tab.id}
            id={`panel-${tab.id}`}
            role="tabpanel"
            aria-labelledby={`tab-${tab.id}`}
            className="paneContent"
            hidden={pane.activeTabId !== tab.id}
            data-pane-id={pane.id}
            style={{
              left: `${rect.x}%`,
              right: `${100 - rect.x - rect.width}%`,
              top: `calc(${rect.y}% + 36px)`,
              bottom: `${100 - rect.y - rect.height}%`,
            }}
            onPointerDownCapture={() => workspace.select(pane.id)}
            onFocusCapture={() => workspace.select(pane.id)}
          >
            <TabRouteContext value={tab.id}>
              {/* oxlint-disable-next-line react/hooks -- Wouter calls the location hook supplied to Router. */}
              <Router hook={usePaneLocation}>
                <MainPane sessions={sessions} />
              </Router>
            </TabRouteContext>
          </div>
        )),
      )}
      {dividers.map(({ split, rect }) => {
        const horizontal = split.axis === "horizontal";
        return (
          <div
            key={split.id}
            role="separator"
            aria-label="Resize panes"
            aria-orientation={horizontal ? "vertical" : "horizontal"}
            aria-valuemin={15}
            aria-valuemax={85}
            aria-valuenow={Math.round(split.ratio * 100)}
            tabIndex={0}
            className="paneDivider"
            data-axis={split.axis}
            style={
              horizontal
                ? {
                    left: `calc(${rect.x + rect.width * split.ratio}% - 3px)`,
                    top: `${rect.y}%`,
                    height: `${rect.height}%`,
                    width: 6,
                  }
                : {
                    top: `calc(${rect.y + rect.height * split.ratio}% - 3px)`,
                    left: `${rect.x}%`,
                    width: `${rect.width}%`,
                    height: 6,
                  }
            }
            onKeyDown={(event) => {
              const decrease = horizontal ? "ArrowLeft" : "ArrowUp";
              const increase = horizontal ? "ArrowRight" : "ArrowDown";
              if (event.key !== decrease && event.key !== increase) return;
              event.preventDefault();
              workspace.resize(
                split.id,
                split.ratio + (event.key === decrease ? -0.05 : 0.05),
              );
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (
                !event.currentTarget.hasPointerCapture(event.pointerId) ||
                root.current === null
              )
                return;
              const box = root.current.getBoundingClientRect();
              const ratio = horizontal
                ? (((event.clientX - box.left) / box.width) * 100 - rect.x) /
                  rect.width
                : (((event.clientY - box.top) / box.height) * 100 - rect.y) /
                  rect.height;
              workspace.resize(split.id, ratio);
            }}
            onPointerUp={(event) =>
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
          />
        );
      })}
    </div>
  );
}

const workspaceStyle = style(
  focusRing("& button:focus-visible, & [role=separator]:focus-visible"),
  text({ size: "sm" }),
  {
    position: "relative",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    backgroundColor: backgroundColor.app,
    "--pane-background": backgroundColor.app,
    "--pane-tab-background": colors.gray[3],
    "--pane-border": colors.gray[6],
    "--pane-muted": colors.gray[11],
    "--pane-accent": colors.accent[9],
    "--pane-hover": colors.gray[4],
    "--pane-drop": colors.accentAlpha[4],
    "& button": { color: "inherit" },
  },
);
