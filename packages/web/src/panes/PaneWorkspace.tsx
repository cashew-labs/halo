import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type CSSProperties,
} from "react";
import { Router } from "wouter";
import type { SessionSummary } from "@get-halo/client";
import { backgroundColor, colors, focusRing, text } from "maui";
import { Plus, Close, Menu } from "maui/icons";
import { style, useStyles } from "purse-styles";
import { MainPane } from "../main/MainPane.js";
import {
  paneLayout,
  type Rect,
  type DropEdge,
  type WorkspaceTab,
} from "./WorkspacePanes.js";
import {
  TabRouteContext,
  usePaneLocation,
  usePaneState,
  useWorkspacePanes,
} from "./WorkspacePanesProvider.js";
import { isPaneDrag, paneRouteDragType, paneTabDragType } from "./paneDrag.js";
import { queryOptions, skipToken, useQueries } from "@tanstack/react-query";
import { useSidebar } from "../WorkspaceLayout.js";
import { useExtensionsQuery, useWorkspaceQuery } from "../api/ApiProvider.js";
import { sessionTitleQueryKey } from "../main/agent/useAgentSession.js";
import { CopyExtensionLinkButton } from "./CopyExtensionLinkButton.js";
import "./paneWorkspace.css";

const tabBarHeight = 42;

function bounds(rect: Rect): CSSProperties {
  return {
    left: `${rect.x}%`,
    top: `${rect.y}%`,
    width: `${rect.width}%`,
    height: `${rect.height}%`,
  };
}
export function PaneWorkspace({ sessions }: { sessions: SessionSummary[] }) {
  const workspace = useWorkspacePanes();
  const sidebar = useSidebar();
  const extensions = useExtensionsQuery(useWorkspaceQuery().data).data;
  const state = usePaneState();
  const { leaves, dividers } = paneLayout(state.root);
  const sessionTabs = leaves
    .flatMap(({ pane }) => pane.tabs)
    .filter((tab) => tab.path.startsWith("/sessions/"));
  const submittedTitles = useQueries({
    queries: sessionTabs.map((tab) =>
      queryOptions<string>({
        queryKey: sessionTitleQueryKey(tab.path.slice(10)),
        queryFn: skipToken,
      }),
    ),
  });
  function tabTitle(tab: WorkspaceTab) {
    if (tab.path.startsWith("/draft/")) return "New session";
    if (tab.path.startsWith("/sessions/")) {
      const id = tab.path.slice(10);
      const submitted =
        submittedTitles[sessionTabs.findIndex((item) => item.id === tab.id)]
          ?.data;
      return (
        sessions.find((session) => session.sessionId === id)?.title ??
        submitted ??
        "Session"
      );
    }
    if (tab.path.startsWith("/extensions/")) {
      const id = decodeURIComponent(tab.path.slice(12));
      return (
        extensions?.find((extension) => extension.id === id)?.displayName ?? id
      );
    }
    return decodeURIComponent(tab.path.split("/").at(-1) ?? tab.path);
  }
  const root = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [drop, setDrop] = useState<{
    paneId: string;
    edge: DropEdge;
    rect: Rect;
  }>();
  useEffect(() => {
    const start = (event: globalThis.DragEvent) => {
      if (event.dataTransfer !== null && isPaneDrag(event.dataTransfer))
        setDragging(true);
    };
    const end = () => {
      setDragging(false);
      setDrop(undefined);
    };
    document.addEventListener("dragstart", start);
    document.addEventListener("dragend", end);
    document.addEventListener("drop", end);
    return () => {
      document.removeEventListener("dragstart", start);
      document.removeEventListener("dragend", end);
      document.removeEventListener("drop", end);
    };
  }, []);
  function targetAt(event: DragEvent) {
    if (root.current === null) return;
    const box = root.current.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * 100;
    const y = ((event.clientY - box.top) / box.height) * 100;
    const target = leaves.find(
      ({ rect }) =>
        x >= rect.x &&
        x <= rect.x + rect.width &&
        y >= rect.y &&
        y <= rect.y + rect.height,
    );
    if (target === undefined) return;
    const { pane, rect } = target;
    const localX = (x - rect.x) / rect.width;
    const localY = (y - rect.y) / rect.height;
    const inTabs = ((y - rect.y) / 100) * box.height < tabBarHeight;
    const distances: [DropEdge, number][] = [
      ["left", localX],
      ["right", 1 - localX],
      ["top", localY],
      ["bottom", 1 - localY],
    ];
    distances.sort((a, b) => a[1] - b[1]);
    const closest = distances[0]!;
    const edge: DropEdge = inTabs || closest[1] > 0.23 ? "center" : closest[0];
    return { paneId: pane.id, edge, rect };
  }

  const className = useStyles(workspaceStyle);

  return (
    <div
      ref={root}
      className={`${className} paneWorkspace`}
      onDragOverCapture={(event) => {
        if (!isPaneDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = event.dataTransfer.types.includes(
          paneTabDragType,
        )
          ? "move"
          : "copy";
        setDrop(targetAt(event));
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setDrop(undefined);
      }}
      onDropCapture={(event) => {
        if (!isPaneDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        const target = targetAt(event);
        const tabId = event.dataTransfer.getData(paneTabDragType) || undefined;
        const path = event.dataTransfer.getData(paneRouteDragType) || undefined;
        if (
          target !== undefined &&
          (tabId !== undefined ||
            (path !== undefined &&
              /^\/(files|sessions|draft|extensions)\//.test(path)))
        )
          workspace.place({ ...target, tabId, path });
        setDragging(false);
        setDrop(undefined);
      }}
    >
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
            {sidebar.isMobile && (
              <button
                type="button"
                className="paneAdd"
                aria-label="Open sidebar"
                aria-haspopup="dialog"
                onClick={sidebar.open}
              >
                <Menu size="sm" />
              </button>
            )}
            <div
              role="tablist"
              aria-label={`Pane ${index + 1} tabs`}
              className="paneTabs"
            >
              {pane.tabs.map((tab, tabIndex) => (
                <div
                  key={tab.id}
                  className="paneTab"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(paneTabDragType, tab.id);
                    event.dataTransfer.effectAllowed = "move";
                  }}
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
                        : tabTitle(tab)
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
                    {tabTitle(tab)}
                  </button>
                  <button
                    type="button"
                    className="paneClose"
                    aria-label={`Close ${tabTitle(tab)}`}
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
              aria-label="New session"
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
            <div className="paneWindowDrag" aria-hidden="true" />
            {pane.tabs
              .filter(
                (tab) =>
                  tab.id === pane.activeTabId &&
                  tab.path.startsWith("/extensions/"),
              )
              .map((tab) => (
                <CopyExtensionLinkButton
                  key={tab.id}
                  extensionId={decodeURIComponent(tab.path.slice(12))}
                />
              ))}
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
              top: `calc(${rect.y}% + ${tabBarHeight}px)`,
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
      {dragging &&
        leaves.map(({ pane, rect }) => (
          <div
            key={pane.id}
            className="paneDropShield"
            style={{
              left: `${rect.x}%`,
              right: `${100 - rect.x - rect.width}%`,
              top: `calc(${rect.y}% + ${tabBarHeight}px)`,
              bottom: `${100 - rect.y - rect.height}%`,
            }}
          />
        ))}
      {drop !== undefined && (
        <div
          className="paneDropPreview"
          data-drop-edge={drop.edge}
          style={bounds(dropPreview(drop.rect, drop.edge))}
        >
          <span>
            {drop.edge === "center"
              ? "Open in this pane"
              : `Split ${drop.edge}`}
          </span>
        </div>
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
    "--pane-tab-height": `${tabBarHeight}px`,
    "--pane-background": backgroundColor.app,
    "--pane-tab-background": colors.gray[2],
    "--pane-border": colors.gray[6],
    "--pane-muted": colors.gray[11],
    "--pane-accent": colors.accent[9],
    "--pane-hover": colors.gray[4],
    "--pane-drop": colors.accentAlpha[4],
    "& button": { color: "inherit" },
  },
);

function dropPreview(rect: Rect, edge: DropEdge): Rect {
  if (edge === "left") return { ...rect, width: rect.width / 2 };
  if (edge === "right")
    return { ...rect, x: rect.x + rect.width / 2, width: rect.width / 2 };
  if (edge === "top") return { ...rect, height: rect.height / 2 };
  if (edge === "bottom")
    return { ...rect, y: rect.y + rect.height / 2, height: rect.height / 2 };
  return rect;
}
