export type WorkspaceTab = { id: string; path: string };
type Pane = {
  kind: "pane";
  id: string;
  tabs: WorkspaceTab[];
  activeTabId: string;
};
type Split = {
  kind: "split";
  id: string;
  axis: "horizontal" | "vertical";
  ratio: number;
  first: PaneNode;
  second: PaneNode;
};
type PaneNode = Pane | Split;
type DropEdge = "center" | "left" | "right" | "top" | "bottom";
export type PaneState = { root: PaneNode; activePaneId: string };
export type Rect = { x: number; y: number; width: number; height: number };

function newTab(path: string): WorkspaceTab {
  return { id: crypto.randomUUID(), path };
}
function newPane(tab: WorkspaceTab): Pane {
  return {
    kind: "pane",
    id: crypto.randomUUID(),
    tabs: [tab],
    activeTabId: tab.id,
  };
}
export function panes(node: PaneNode): Pane[] {
  return node.kind === "pane"
    ? [node]
    : [...panes(node.first), ...panes(node.second)];
}
function mapNode(
  node: PaneNode,
  id: string,
  update: (node: PaneNode) => PaneNode,
): PaneNode {
  if (node.id === id) return update(node);
  if (node.kind === "pane") return node;
  return {
    ...node,
    first: mapNode(node.first, id, update),
    second: mapNode(node.second, id, update),
  };
}
function removeTab(node: PaneNode, tabId: string): PaneNode | undefined {
  if (node.kind === "split") {
    const first = removeTab(node.first, tabId);
    const second = removeTab(node.second, tabId);
    if (first === undefined) return second;
    if (second === undefined) return first;
    return { ...node, first, second };
  }
  const index = node.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return node;
  const tabs = node.tabs.filter((tab) => tab.id !== tabId);
  const active = tabs[Math.min(index, tabs.length - 1)];
  if (active === undefined) return undefined;
  return {
    ...node,
    tabs,
    activeTabId: node.activeTabId === tabId ? active.id : node.activeTabId,
  };
}

// One instance per workspace shell owns navigation and layout. Views subscribe to
// immutable snapshots; tab IDs survive moves so React retains their editors.
export class WorkspacePanes {
  private state: PaneState;
  private readonly listeners = new Set<() => void>();
  private readonly initialPath: string;

  constructor(initialPath: string) {
    this.initialPath = initialPath;
    const pane = newPane(newTab(this.hashPath()));
    this.state = { root: pane, activePaneId: pane.id };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private hashPath() {
    const path = window.location.hash.slice(1);
    return path === "" || path === "/" ? this.initialPath : path;
  }
  followHistory = () => this.open({ path: this.hashPath(), history: false });
  private publish(
    state: PaneState,
    history: "push" | "replace" | false = "push",
  ) {
    this.state = state;
    const pane = panes(state.root).find(
      (candidate) => candidate.id === state.activePaneId,
    )!;
    const tab = pane.tabs.find(
      (candidate) => candidate.id === pane.activeTabId,
    )!;
    if (history !== false && window.location.hash.slice(1) !== tab.path) {
      window.history[history === "replace" ? "replaceState" : "pushState"](
        window.history.state,
        "",
        `#${tab.path}`,
      );
    }
    for (const listener of this.listeners) listener();
  }
  activePane() {
    return panes(this.state.root).find(
      (pane) => pane.id === this.state.activePaneId,
    )!;
  }
  open({
    path,
    newTab: append = false,
    tabId,
    history = "push",
  }: {
    path: string;
    newTab?: boolean;
    tabId?: string;
    history?: "push" | "replace" | false;
  }) {
    if (path === "/") path = this.initialPath;
    const target =
      tabId === undefined
        ? this.activePane()
        : panes(this.state.root).find((pane) =>
            pane.tabs.some((candidate) => candidate.id === tabId),
          );
    if (target === undefined) return;
    const existing = target.tabs.find((tab) => tab.path === path);
    const tab =
      existing ??
      (append ? newTab(path) : { id: tabId ?? target.activeTabId, path });
    const tabs =
      existing !== undefined
        ? target.tabs
        : append
          ? [...target.tabs, tab]
          : target.tabs.map((item) => (item.id === tab.id ? tab : item));
    this.publish(
      {
        root: mapNode(this.state.root, target.id, () => ({
          ...target,
          tabs,
          activeTabId: tab.id,
        })),
        activePaneId: target.id,
      },
      history,
    );
  }
  select(paneId: string, tabId?: string) {
    const pane = panes(this.state.root).find(
      (candidate) => candidate.id === paneId,
    );
    if (pane === undefined) return;
    const activeTabId = tabId ?? pane.activeTabId;
    if (this.state.activePaneId === paneId && pane.activeTabId === activeTabId)
      return;
    this.publish({
      root: mapNode(this.state.root, paneId, () => ({ ...pane, activeTabId })),
      activePaneId: paneId,
    });
  }
  close(tabId: string) {
    const root =
      removeTab(this.state.root, tabId) ??
      newPane(newTab(`/draft/${crypto.randomUUID()}`));
    const remaining = panes(root);
    const activePaneId = remaining.some(
      (pane) => pane.id === this.state.activePaneId,
    )
      ? this.state.activePaneId
      : remaining[0]!.id;
    this.publish({ root, activePaneId });
  }
  place({
    paneId,
    edge,
    tabId,
    path,
  }: {
    paneId: string;
    edge: DropEdge;
    tabId?: string;
    path?: string;
  }) {
    const all = panes(this.state.root);
    const target = all.find((candidate) => candidate.id === paneId);
    const source = all.find((pane) =>
      pane.tabs.some((candidate) => candidate.id === tabId),
    );
    const tab =
      source?.tabs.find((candidate) => candidate.id === tabId) ??
      (path === undefined ? undefined : newTab(path));
    if (target === undefined || tab === undefined) return;
    if (
      source?.id === paneId &&
      (edge === "center" || source.tabs.length === 1)
    ) {
      this.select(paneId, tab.id);
      return;
    }
    let root = this.state.root;
    if (source !== undefined) root = removeTab(root, tab.id)!;
    if (edge === "center") {
      const existing = target.tabs.find((item) => item.path === tab.path);
      const updated = {
        ...target,
        tabs: existing === undefined ? [...target.tabs, tab] : target.tabs,
        activeTabId: existing?.id ?? tab.id,
      };
      this.publish({
        root: mapNode(root, paneId, () => updated),
        activePaneId: paneId,
      });
      return;
    }
    const added = newPane(tab);
    const before = edge === "left" || edge === "top";
    root = mapNode(root, paneId, (node) => ({
      kind: "split",
      id: crypto.randomUUID(),
      axis: edge === "left" || edge === "right" ? "horizontal" : "vertical",
      ratio: 0.5,
      first: before ? added : node,
      second: before ? node : added,
    }));
    this.publish({ root, activePaneId: added.id });
  }
  resize(id: string, ratio: number) {
    this.publish(
      {
        ...this.state,
        root: mapNode(this.state.root, id, (node) =>
          node.kind === "split"
            ? { ...node, ratio: Math.max(0.15, Math.min(0.85, ratio)) }
            : node,
        ),
      },
      false,
    );
  }
  updateFiles(source: string, destination?: string) {
    for (const pane of panes(this.state.root)) {
      for (const tab of pane.tabs) {
        if (!tab.path.startsWith("/files/")) continue;
        const path = decodeURIComponent(tab.path.slice(7));
        if (path !== source && !path.startsWith(`${source}/`)) continue;
        if (destination === undefined) this.close(tab.id);
        else {
          const renamed = destination + path.slice(source.length);
          const current = panes(this.state.root).find(
            (item) => item.id === pane.id,
          )!;
          this.publish(
            {
              ...this.state,
              root: mapNode(this.state.root, pane.id, () => ({
                ...current,
                tabs: current.tabs.map((item) =>
                  item.id === tab.id
                    ? {
                        ...item,
                        path: `/files/${renamed.split("/").map(encodeURIComponent).join("/")}`,
                      }
                    : item,
                ),
              })),
            },
            "replace",
          );
        }
      }
    }
  }
}

export function paneLayout(root: PaneNode) {
  const leaves: { pane: Pane; rect: Rect }[] = [];
  const dividers: { split: Split; rect: Rect }[] = [];
  function visit(node: PaneNode, rect: Rect) {
    if (node.kind === "pane") {
      leaves.push({ pane: node, rect });
      return;
    }
    dividers.push({ split: node, rect });
    if (node.axis === "horizontal") {
      const width = rect.width * node.ratio;
      visit(node.first, { ...rect, width });
      visit(node.second, {
        ...rect,
        x: rect.x + width,
        width: rect.width - width,
      });
    } else {
      const height = rect.height * node.ratio;
      visit(node.first, { ...rect, height });
      visit(node.second, {
        ...rect,
        y: rect.y + height,
        height: rect.height - height,
      });
    }
  }
  visit(root, { x: 0, y: 0, width: 100, height: 100 });
  return { leaves, dividers };
}
