import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type CSSProperties,
} from "react";
import { Router } from "wouter";
import type { SessionSummary } from "@get-halo/client";
import { Plus, Close, Menu } from "maui/icons";
import { MainPane } from "../main/MainPane.js";
import {
  paneLayout,
  type Rect,
  type DropEdge,
  type WorkspaceTab,
} from "./WorkspacePanes.js";
import {
  TabRouteContext,
  TabVisibilityContext,
  usePaneLocation,
  usePaneState,
  useWorkspacePanes,
} from "./WorkspacePanesProvider.js";
import { isPaneDrag, paneRouteDragType, paneTabDragType } from "./paneDrag.js";
import { queryOptions, skipToken, useQueries } from "@tanstack/react-query";
import { useSidebar } from "../WorkspaceLayout.js";
import { useExtensions, useRoutines } from "../api/WorkspaceUpdatesProvider.js";
import { sessionTitleQueryKey } from "../main/agent/useAgentSession.js";
import { CopyExtensionLinkButton } from "./CopyExtensionLinkButton.js";
import { tabBarHeight, usePaneStyles } from "./paneStyles.js";

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
  const extensions = useExtensions().data;
  const routines = useRoutines();
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
    if (tab.path.startsWith("/routines/")) {
      const id = decodeURIComponent(tab.path.slice(10));
      return routines?.find((routine) => routine.id === id)?.name ?? "Routine";
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

  const chrome = usePaneStyles();

  function openFileLink(event: MouseEvent, paneId: string, sourcePath: string) {
    if (event.type === "click" ? event.button !== 0 : event.button !== 1)
      return;
    const link =
      event.target instanceof Element
        ? event.target.closest("a[href]")
        : undefined;
    if (!(link instanceof HTMLAnchorElement)) return;
    const href = link.getAttribute("href")?.trim();
    if (!href) return;
    let path: string;
    if (href.startsWith("#/files/")) path = href.slice(1);
    else if (href.startsWith("/files/")) path = href;
    else {
      if (
        /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href) ||
        /^\/(?:sessions|draft|extensions)\//.test(href)
      )
        return;
      const documentPath = sourcePath.startsWith("/files/")
        ? decodeURIComponent(sourcePath.slice(7))
            .split("/")
            .map(encodeURIComponent)
            .join("/")
        : "";
      const base = new URL(documentPath, "https://workspace.invalid/");
      path = `/files${new URL(href, base).pathname}`;
    }
    event.preventDefault();
    event.stopPropagation();
    workspace.select(paneId);
    workspace.open({ path, newTab: true });
  }

  return (
    <div
      ref={root}
      data-testid="pane-workspace"
      className={chrome.workspace}
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
          className={chrome.pane}
          style={bounds(rect)}
          data-pane-id={pane.id}
          data-active={state.activePaneId === pane.id}
          aria-label={`Pane ${index + 1}`}
          onPointerDownCapture={() => workspace.select(pane.id)}
        >
          <div className={chrome.tabBar} data-testid="pane-tab-bar">
            {sidebar.isMobile && (
              <button
                type="button"
                className={chrome.add}
                data-pane-add=""
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
              className={chrome.tabs}
            >
              {pane.tabs.map((tab, tabIndex) => (
                <div
                  key={tab.id}
                  className={chrome.tab}
                  data-pane-tab=""
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(paneTabDragType, tab.id);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  data-selected={pane.activeTabId === tab.id}
                >
                  <div className={chrome.tabInner} data-pane-tab-inner="">
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
                      className={chrome.close}
                      data-pane-close=""
                      aria-label={`Close ${tabTitle(tab)}`}
                      title="Close tab"
                      onClick={() => workspace.close(tab.id)}
                    >
                      <Close size="sm" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              className={chrome.add}
              data-pane-add=""
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
            <div className={chrome.windowDrag} aria-hidden="true" />
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
            className={chrome.content}
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
            onClickCapture={(event) => openFileLink(event, pane.id, tab.path)}
            onAuxClickCapture={(event) =>
              openFileLink(event, pane.id, tab.path)
            }
          >
            <TabVisibilityContext value={pane.activeTabId === tab.id}>
              <TabRouteContext value={tab.id}>
                {/* oxlint-disable-next-line react/hooks -- Wouter calls the location hook supplied to Router. */}
                <Router hook={usePaneLocation}>
                  <MainPane sessions={sessions} />
                </Router>
              </TabRouteContext>
            </TabVisibilityContext>
          </div>
        )),
      )}
      {dragging &&
        leaves.map(({ pane, rect }) => (
          <div
            key={pane.id}
            className={chrome.dropShield}
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
          className={chrome.dropPreview}
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
            className={chrome.divider}
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

function dropPreview(rect: Rect, edge: DropEdge): Rect {
  if (edge === "left") return { ...rect, width: rect.width / 2 };
  if (edge === "right")
    return { ...rect, x: rect.x + rect.width / 2, width: rect.width / 2 };
  if (edge === "top") return { ...rect, height: rect.height / 2 };
  if (edge === "bottom")
    return { ...rect, y: rect.y + rect.height / 2, height: rect.height / 2 };
  return rect;
}
