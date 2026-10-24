import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as errore from "errore";
import { useIsPresent, useReducedMotion } from "motion/react";
import {
  Button,
  Checkbox,
  Crossfade,
  Flex,
  Text,
  backgroundColor,
  border,
  borderColor,
  colors,
  flex,
  focusRing,
  motion,
  radius,
  shadow,
  spacing,
  text,
  useTheme,
} from "maui";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Minus,
  Moon,
  Plus,
  Sidebar,
  Sun,
} from "maui/icons";
import { style, useStyles } from "purse-styles";

const thumbnailPadding = 8;
const thumbnailHeaderHeight = 24;
const thumbnailGap = 8;

export type FlowNode = {
  id: string;
  title: string;
  parent?: string;
  action: string;
  /** Vertical ordering within its column; missing rows do not reserve space. */
  row: number;
  note?: string;
  /** Maximum unscaled preview size; defaults to the scenario dimensions. */
  maxWidth?: number;
  maxHeight?: number;
  render: (context: { mode: "thumbnail" | "preview" }) => ReactNode;
};

export type FlowScenario = {
  id: string;
  title: string;
  description?: string;
  /** Accessible name prefix, for example “Settings flow”. */
  navigationLabel?: string;
  initialState: string;
  /** Parent-first, unique IDs; rows are nonnegative. */
  nodes: readonly FlowNode[];
  dimensions?: {
    nodeWidth?: number;
    nodeHeight?: number;
    previewWidth?: number;
    columnGap?: number;
    rowGap?: number;
  };
  reviewStorageKey?: string;
};

class ReviewError extends errore.createTaggedError({
  name: "ReviewError",
  message: "Could not $operation preview reviews.",
}) {}

class LayoutError extends errore.createTaggedError({
  name: "LayoutError",
  message: "Could not $operation sidebar width.",
}) {}

function useSidebarWidth({
  storageKey,
  initialWidth,
}: {
  storageKey: string;
  initialWidth: number;
}) {
  const [width, setWidth] = useState(() => {
    const saved = errore.try({
      try: () => Number(localStorage.getItem(storageKey) ?? initialWidth),
      catch: (cause) => new LayoutError({ operation: "load", cause }),
    });
    if (saved instanceof Error) {
      console.warn(saved);
      return initialWidth;
    }
    return Number.isFinite(saved) && saved > 0 ? saved : initialWidth;
  });
  useEffect(() => {
    const saved = errore.try({
      try: () => localStorage.setItem(storageKey, String(width)),
      catch: (cause) => new LayoutError({ operation: "save", cause }),
    });
    if (saved instanceof Error) console.warn(saved);
  }, [storageKey, width]);
  return [width, setWidth] as const;
}

export function FlowCanvas({ scenario }: { scenario: FlowScenario }) {
  const { nodes: steps } = scenario;
  const nodeWidth = scenario.dimensions?.nodeWidth ?? 160;
  const nodeHeight = scenario.dimensions?.nodeHeight ?? 212;
  const previewWidth = scenario.dimensions?.previewWidth ?? 440;
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [treeWidth, setTreeWidth] = useSidebarWidth({
    storageKey: `flow-width:${scenario.id}:outline`,
    initialWidth: 248,
  });
  const [panelWidth, setPanelWidth] = useSidebarWidth({
    storageKey: `flow-width:${scenario.id}:preview`,
    // Include the aside's 20px inset and the panel's 16px inset plus border on both sides.
    initialWidth: previewWidth + 40 + 34,
  });
  const layoutRef = useRef<HTMLDivElement>(null);
  const [layoutWidth, setLayoutWidth] = useState(window.innerWidth);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setLayoutWidth(entry!.contentRect.width),
    );
    observer.observe(layoutRef.current!);
    return () => observer.disconnect();
  }, []);
  const treeMaximum = Math.max(
    180,
    Math.min(480, layoutWidth - (layoutWidth <= 900 ? 40 : 560)),
  );
  const shownTreeWidth = Math.min(treeMaximum, Math.max(180, treeWidth));
  const panelMaximum = Math.max(
    320,
    Math.min(960, layoutWidth - (sidebarOpen ? shownTreeWidth : 0) - 240),
  );
  const shownPanelWidth = Math.min(panelMaximum, Math.max(320, panelWidth));
  const contentStyle: CSSProperties & {
    "--flow-preview-width": string;
    "--flow-tree-width": string;
  } = {
    "--flow-preview-width": `${shownPanelWidth}px`,
    "--flow-tree-width": `${shownTreeWidth}px`,
  };
  const [resizing, setResizing] = useState(false);
  const columnGap = scenario.dimensions?.columnGap ?? 56;
  const rowGap = scenario.dimensions?.rowGap ?? 64;
  const label = scenario.navigationLabel ?? "Flow";
  const storageKey =
    scenario.reviewStorageKey ?? `flow-reviewed-v1:${scenario.id}`;
  const outlineId = `${scenario.id}-flow-outline`;
  const [thumbnailHeights, setThumbnailHeights] = useState<
    Record<string, number>
  >({});
  const [thumbnailHeaderHeights, setThumbnailHeaderHeights] = useState<
    Record<string, number>
  >({});
  const nodes = useMemo(() => {
    const positioned = new Map<
      string,
      FlowNode & { x: number; y: number; height: number; headerHeight: number }
    >();
    for (const step of steps) {
      positioned.set(step.id, {
        ...step,
        x: step.parent
          ? positioned.get(step.parent)!.x + nodeWidth + columnGap
          : 24,
        y: 0,
        height: thumbnailHeights[step.id] ?? nodeHeight,
        headerHeight: thumbnailHeaderHeights[step.id] ?? thumbnailHeaderHeight,
      });
    }
    // Pack each depth independently instead of reserving empty global rows.
    const nextTop = new Map<number, number>();
    // oxlint-disable-next-line unicorn/no-array-sort -- Sort a fresh array without requiring ES2023 browser APIs.
    for (const node of [...positioned.values()].sort((a, b) => a.row - b.row)) {
      node.y =
        (nextTop.get(node.x) ?? 16) +
        thumbnailPadding +
        node.headerHeight +
        thumbnailGap;
      nextTop.set(
        node.x,
        node.y +
          node.height +
          thumbnailPadding +
          Math.max(
            8,
            rowGap -
              thumbnailPadding * 2 -
              thumbnailHeaderHeight -
              thumbnailGap,
          ),
      );
    }
    return positioned;
  }, [
    steps,
    nodeWidth,
    nodeHeight,
    columnGap,
    rowGap,
    thumbnailHeights,
    thumbnailHeaderHeights,
  ]);
  const graphWidth =
    Math.max(...[...nodes.values()].map((node) => node.x)) + nodeWidth + 24;
  const graphHeight =
    Math.max(...[...nodes.values()].map((node) => node.y + node.height)) + 24;
  const [selected, setSelected] = useState(scenario.initialState);
  const [revision, setRevision] = useState(0);
  const [zoom, setZoom] = useState(0.85);
  const reduceMotion = useReducedMotion();
  const centered = useRef(false);
  const thumbnailRefs = useRef(new Map<string, HTMLDivElement>());
  const thumbnailHeaderRefs = useRef(new Map<string, HTMLDivElement>());
  useLayoutEffect(() => {
    const measure = () => {
      setThumbnailHeights(
        Object.fromEntries(
          steps.map((step) => [
            step.id,
            Math.min(
              nodeHeight,
              (Math.min(
                thumbnailRefs.current.get(step.id)!.offsetHeight,
                step.maxHeight ?? Infinity,
              ) *
                nodeWidth) /
                (step.maxWidth ?? previewWidth),
            ),
          ]),
        ),
      );
      setThumbnailHeaderHeights(
        Object.fromEntries(
          [...thumbnailHeaderRefs.current].map(([id, element]) => [
            id,
            element.offsetHeight,
          ]),
        ),
      );
    };
    const observer = new ResizeObserver(measure);
    for (const step of steps) {
      observer.observe(thumbnailRefs.current.get(step.id)!);
      observer.observe(thumbnailHeaderRefs.current.get(step.id)!);
    }
    measure();
    return () => observer.disconnect();
  }, [steps, nodeHeight, nodeWidth, previewWidth]);
  const select = (id: string) => {
    setSelected(id);
    setRevision((value) => value + 1);
  };
  const [signatures, setSignatures] = useState<Record<string, string>>({});
  const [reviewed, setReviewed] = useState<string[]>([]);
  const markReviewed = (id: string, checked: boolean) => {
    const signature = signatures[id];
    if (!signature) return;
    const saved = errore.try({
      try: () => {
        const key = `${storageKey}:${id}`;
        if (checked) localStorage.setItem(key, signature);
        else localStorage.removeItem(key);
      },
      catch: (cause) => new ReviewError({ operation: "save", cause }),
    });
    if (saved instanceof Error) console.warn(saved);
    setReviewed((previous) =>
      checked
        ? [...new Set([...previous, id])]
        : previous.filter((item) => item !== id),
    );
  };
  useEffect(() => {
    // Fingerprint inert thumbnails, not the interactive drafts. Generated IDs,
    // animation frames, and theme values must not invalidate a review.
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      void Promise.all(
        steps.map(async (step) => {
          // SAFETY: cloneNode preserves the HTMLDivElement registered by the thumbnail ref.
          const clone = thumbnailRefs.current
            .get(step.id)!
            .cloneNode(true) as HTMLElement;
          for (const element of [clone, ...clone.querySelectorAll("*")]) {
            for (const attribute of element.getAttributeNames()) {
              if (
                attribute === "id" ||
                attribute === "data-alive" ||
                /^(aria-labelledby|aria-describedby|aria-controls|aria-owns|aria-activedescendant)$/.test(
                  attribute,
                )
              )
                element.removeAttribute(attribute);
            }
            if (element instanceof HTMLElement) {
              element.style.removeProperty("opacity");
              element.style.removeProperty("transform");
              if (
                element.tagName === "DIV" &&
                element.closest("[aria-busy='true']")
              )
                element.style.removeProperty("height");
              if (element.getAttribute("style") === "")
                element.removeAttribute("style");
            }
          }
          const bytes = new TextEncoder().encode(
            `${step.action}:${clone.innerHTML}`,
          );
          const digest = await crypto.subtle
            .digest("SHA-256", bytes)
            .catch(
              (cause) => new ReviewError({ operation: "fingerprint", cause }),
            );
          if (digest instanceof Error) return digest;
          return [
            step.id,
            [...new Uint8Array(digest)]
              .map((value) => value.toString(16).padStart(2, "0"))
              .join(""),
          ] as const;
        }),
      )
        .then((entries) => {
          if (cancelled) return;
          const validEntries = entries.filter(
            (entry): entry is readonly [string, string] => {
              if (entry instanceof Error) {
                console.warn(entry);
                return false;
              }
              return true;
            },
          );
          const nextSignatures = Object.fromEntries(validEntries);
          setSignatures(nextSignatures);
          const stored = errore.try({
            try: () =>
              validEntries
                .filter(
                  ([id, signature]) =>
                    localStorage.getItem(`${storageKey}:${id}`) === signature,
                )
                .map(([id]) => id),
            catch: (cause) => new ReviewError({ operation: "load", cause }),
          });
          if (stored instanceof Error) {
            console.warn(stored);
            return;
          }
          setReviewed(stored);
        })
        .catch((cause) =>
          console.warn(new ReviewError({ operation: "fingerprint", cause })),
        );
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [steps, storageKey]);
  const { resolvedTheme, setPreference } = useTheme();
  const scroller = useRef<HTMLDivElement>(null);
  const previewScroller = useRef<HTMLElement>(null);
  const page = useStyles(styles.page);
  const header = useStyles(styles.header);
  const content = useStyles(styles.content, !sidebarOpen && styles.collapsed);
  const sidebarToggle = useStyles(
    styles.sidebarToggle,
    !sidebarOpen && styles.toggleCollapsed,
  );
  const treeSlot = useStyles(styles.treeSlot);
  const tree = useStyles(styles.tree, !sidebarOpen && styles.treeClosed);
  const treeList = useStyles(styles.treeList);
  const treeRow = useStyles(styles.treeRow);
  const treeButton = useStyles(styles.treeButton);
  const mapPane = useStyles(styles.mapPane);
  const map = useStyles(styles.map);
  const graph = useStyles(styles.graph);
  const nodeStyle = useStyles(styles.node);
  const thumbnail = useStyles(styles.thumbnail);
  const reviewedMark = useStyles(styles.reviewedMark);
  const hit = useStyles(styles.hit);
  const nodeHeader = useStyles(styles.nodeHeader);
  const nodeBody = useStyles(styles.nodeBody);
  const reviewCheckbox = useStyles(styles.reviewCheckbox);
  const edge = useStyles(styles.edge);
  const preview = useStyles(styles.preview);
  const previewPanel = useStyles(styles.previewPanel);
  const navigationButton = useStyles(styles.navigationButton);
  const title = useStyles(text({ size: "lg", fontWeight: 600 }));
  const current = nodes.get(selected)!;
  const next = steps.filter((step) => step.parent === selected);
  const path = new Set<string>();
  let ancestor: string | undefined = selected;
  while (ancestor) {
    path.add(ancestor);
    ancestor = nodes.get(ancestor)!.parent;
  }

  useLayoutEffect(() => {
    const viewport = scroller.current!;
    viewport.scrollTo({
      behavior: !centered.current || reduceMotion ? "instant" : "smooth",
      left: Math.max(
        0,
        (current.x + nodeWidth / 2) * zoom - viewport.clientWidth / 2,
      ),
      top: Math.max(
        0,
        (current.y + current.height / 2) * zoom - viewport.clientHeight / 2,
      ),
    });
    centered.current = true;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Reselecting/resetting a state recenters its thumbnail too.
  }, [zoom, current, revision, reduceMotion, nodeWidth]);

  useLayoutEffect(() => {
    previewScroller.current!.scrollTop = 0;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Selection and explicit reset both restore the preview scroll position.
  }, [selected, revision]);

  const renderTree = (parent?: string): ReactNode => (
    <ul className={treeList}>
      {steps
        .filter((step) => step.parent === parent)
        .map((step) => {
          return (
            <li key={step.id}>
              <div className={treeRow} data-selected={selected === step.id}>
                <Button
                  className={treeButton}
                  variant="quiet"
                  aria-current={selected === step.id ? "step" : undefined}
                  onPress={() => select(step.id)}
                >
                  {step.title}
                </Button>
                <div
                  className={reviewCheckbox}
                  role="group"
                  aria-label={`Review in tree: ${step.title}`}
                >
                  <Checkbox
                    label="Reviewed"
                    checked={reviewed.includes(step.id)}
                    setChecked={(checked: boolean) =>
                      markReviewed(step.id, checked)
                    }
                  />
                </div>
              </div>
              {steps.some((child) => child.parent === step.id) &&
                renderTree(step.id)}
            </li>
          );
        })}
    </ul>
  );

  return (
    <main className={page}>
      <header className={header}>
        <Flex column gap={3}>
          <h1 className={title}>{scenario.title}</h1>
          {scenario.description && (
            <Text size="xs" color="lowContrast">
              {scenario.description}
            </Text>
          )}
        </Flex>
        <Button
          onPress={() =>
            setPreference(resolvedTheme === "dark" ? "light" : "dark")
          }
          aria-label="Toggle theme"
        >
          {resolvedTheme === "dark" ? <Sun /> : <Moon />}
          {resolvedTheme === "dark" ? "Light mode" : "Dark mode"}
        </Button>
      </header>
      <div
        ref={layoutRef}
        className={content}
        data-sidebar-open={sidebarOpen}
        data-resizing={resizing}
        style={contentStyle}
      >
        <Button
          className={sidebarToggle}
          variant="quiet"
          aria-label="Toggle flow sidebar"
          aria-expanded={sidebarOpen}
          aria-controls={outlineId}
          onPress={() => setSidebarOpen((open) => !open)}
        >
          <Sidebar size="sm" />
        </Button>
        <div className={treeSlot}>
          <nav
            id={outlineId}
            className={tree}
            aria-label={`${label} outline`}
            inert={!sidebarOpen}
            aria-hidden={!sidebarOpen}
          >
            {renderTree()}
          </nav>
        </div>
        {sidebarOpen && (
          <SidebarResizeHandle
            side="left"
            label="Resize flow outline"
            value={shownTreeWidth}
            minimum={180}
            maximum={treeMaximum}
            setValue={setTreeWidth}
            onResizingChange={setResizing}
          />
        )}
        <SidebarResizeHandle
          side="right"
          label="Resize state preview"
          value={shownPanelWidth}
          minimum={320}
          maximum={panelMaximum}
          setValue={setPanelWidth}
          onResizingChange={setResizing}
        />
        <section className={mapPane} aria-label={`${label} map`}>
          <Flex
            row
            justifyContent="end"
            alignItems="center"
            px={8}
            py={4}
            style={{ flexWrap: "wrap", gap: 8 }}
          >
            <Flex row gap={3} alignItems="center">
              <Button
                size="sm"
                aria-label="Zoom out"
                isDisabled={zoom <= 0.45}
                onPress={() => setZoom((value) => Math.max(0.45, value - 0.1))}
              >
                <Minus />
              </Button>
              <Text size="xs" tabular>
                {Math.round(zoom * 100)}%
              </Text>
              <Button
                size="sm"
                aria-label="Zoom in"
                isDisabled={zoom >= 1.15}
                onPress={() => setZoom((value) => Math.min(1.15, value + 0.1))}
              >
                <Plus />
              </Button>
              <Button size="sm" onPress={() => select(scenario.initialState)}>
                Start
              </Button>
            </Flex>
          </Flex>
          <div
            className={map}
            ref={scroller}
            tabIndex={0}
            aria-label="Scrollable flow map"
          >
            <div
              style={{ width: graphWidth * zoom, height: graphHeight * zoom }}
            >
              <nav
                className={graph}
                aria-label={`${label} states`}
                style={{
                  width: graphWidth,
                  height: graphHeight,
                  transform: `scale(${zoom})`,
                }}
              >
                <svg
                  aria-hidden="true"
                  width={graphWidth}
                  height={graphHeight}
                  style={{
                    position: "absolute",
                    inset: 0,
                    pointerEvents: "none",
                  }}
                >
                  {steps
                    .filter((step) => step.parent)
                    .map((step) => {
                      const from = nodes.get(step.parent!)!;
                      const to = nodes.get(step.id)!;
                      const startX = from.x + nodeWidth;
                      const startY = from.y + from.height / 2;
                      const endY = to.y + to.height / 2;
                      const elbow = startX + columnGap / 2;
                      return (
                        <path
                          key={step.id}
                          className={edge}
                          d={`M ${startX} ${startY} H ${elbow} V ${endY} H ${to.x - 8} l -5 -4 m 5 4 l -5 4`}
                          fill="none"
                          stroke={
                            path.has(step.id)
                              ? colors.accent[8]
                              : colors.gray[8]
                          }
                          strokeWidth={path.has(step.id) ? 2 : 1.5}
                        />
                      );
                    })}
                </svg>
                {steps.map((step) => {
                  const node = nodes.get(step.id)!;
                  return (
                    <div
                      key={step.id}
                      className={nodeStyle}
                      data-selected={selected === step.id}
                      style={{
                        left: node.x - thumbnailPadding,
                        top:
                          node.y -
                          thumbnailPadding -
                          node.headerHeight -
                          thumbnailGap,
                        width: nodeWidth + thumbnailPadding * 2,
                        height:
                          node.height +
                          thumbnailPadding * 2 +
                          node.headerHeight +
                          thumbnailGap,
                      }}
                    >
                      <div
                        className={nodeHeader}
                        ref={(element) => {
                          if (element)
                            thumbnailHeaderRefs.current.set(step.id, element);
                          else thumbnailHeaderRefs.current.delete(step.id);
                        }}
                      >
                        <Text
                          data-flow-title
                          size="sm"
                          fontWeight={500}
                          style={{ flex: 1 }}
                        >
                          {step.title}
                        </Text>
                        <div
                          className={reviewCheckbox}
                          role="group"
                          aria-label={`Review ${step.title}`}
                        >
                          <Checkbox
                            label="Reviewed"
                            checked={reviewed.includes(step.id)}
                            setChecked={(checked: boolean) =>
                              markReviewed(step.id, checked)
                            }
                          />
                        </div>
                      </div>
                      <div className={nodeBody} style={{ height: node.height }}>
                        <div
                          className={thumbnail}
                          data-reviewed={reviewed.includes(step.id)}
                          aria-hidden="true"
                          inert
                        >
                          <div
                            ref={(element) => {
                              if (element)
                                thumbnailRefs.current.set(step.id, element);
                              else thumbnailRefs.current.delete(step.id);
                            }}
                            style={{
                              width: step.maxWidth ?? previewWidth,
                              transform: `scale(${nodeWidth / (step.maxWidth ?? previewWidth)})`,
                              transformOrigin: "top left",
                            }}
                          >
                            {step.render({ mode: "thumbnail" })}
                          </div>
                        </div>
                        {reviewed.includes(step.id) && (
                          <div
                            className={reviewedMark}
                            role="img"
                            aria-label={`Reviewed: ${step.title}`}
                          >
                            <Check size="lg" aria-hidden="true" />
                          </div>
                        )}
                      </div>
                      <Button
                        className={hit}
                        data-flow-state={step.id}
                        aria-label={`Preview ${step.title}`}
                        aria-pressed={selected === step.id}
                        onPress={() => select(step.id)}
                      >
                        {undefined}
                      </Button>
                    </div>
                  );
                })}
              </nav>
            </div>
          </div>
        </section>
        <aside
          className={preview}
          ref={previewScroller}
          aria-label="Selected state preview"
        >
          <Flex row justifyContent="end" alignItems="center" gap={4}>
            <Button size="sm" onPress={() => setRevision((value) => value + 1)}>
              Reset preview
            </Button>
          </Flex>
          <Crossfade
            contentKey={selected}
            direction="up"
            style={{
              minHeight: 0,
              gridTemplateRows: "minmax(0, 1fr)",
              overflow: "visible",
            }}
          >
            <PreviewScene>
              <Flex column gap={4}>
                <Flex row justifyContent="between" alignItems="center" gap={4}>
                  <h2 className={title} style={{ margin: 0 }}>
                    {current.title}
                  </h2>
                  <div className={reviewCheckbox}>
                    <Checkbox
                      label="Reviewed"
                      checked={reviewed.includes(selected)}
                      setChecked={(checked: boolean) =>
                        markReviewed(selected, checked)
                      }
                    />
                  </div>
                </Flex>
                {current.note && (
                  <Text size="sm" color="lowContrast">
                    {current.note}
                  </Text>
                )}
              </Flex>
              <div
                key={`${selected}-${revision}`}
                className={previewPanel}
                style={{
                  maxWidth: `calc(${current.maxWidth ?? previewWidth}px + ${spacing.value(8)} * 2 + 2px)`,
                  maxHeight: `calc(${current.maxHeight ?? (nodeHeight * (current.maxWidth ?? previewWidth)) / nodeWidth}px + ${spacing.value(8)} * 2 + 2px)`,
                }}
              >
                <div style={{ width: "100%", flexShrink: 0 }}>
                  {current.render({ mode: "preview" })}
                </div>
              </div>
              <Flex
                row
                gap={4}
                justifyContent="end"
                style={{ flexWrap: "wrap" }}
              >
                {current.parent && (
                  <Button
                    className={navigationButton}
                    onPress={() => select(current.parent!)}
                  >
                    <ArrowLeft />
                    Previous state
                  </Button>
                )}
                {next.map((step) => (
                  <Button
                    key={step.id}
                    aria-label={`Follow flow: ${step.action}`}
                    className={navigationButton}
                    onPress={() => select(step.id)}
                  >
                    {step.action}
                    <ArrowRight />
                  </Button>
                ))}
              </Flex>
            </PreviewScene>
          </Crossfade>
        </aside>
      </div>
    </main>
  );
}

function PreviewScene({ children }: { children: ReactNode }) {
  const present = useIsPresent();
  const scene = useStyles(styles.scene);
  return (
    <div className={scene} inert={!present} aria-hidden={!present}>
      {children}
    </div>
  );
}

function SidebarResizeHandle({
  side,
  label,
  value,
  minimum,
  maximum,
  setValue,
  onResizingChange,
}: {
  side: "left" | "right";
  label: string;
  value: number;
  minimum: number;
  maximum: number;
  setValue: (width: number) => void;
  onResizingChange: (resizing: boolean) => void;
}) {
  const handle = useStyles(styles.resizeHandle);
  const drag = useRef<{ x: number; width: number } | undefined>(undefined);
  const direction = side === "left" ? 1 : -1;
  const resize = (width: number) =>
    setValue(Math.max(minimum, Math.min(maximum, width)));
  return (
    <div
      className={handle}
      data-side={side}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={maximum}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width: value };
        onResizingChange(true);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        resize(
          drag.current.width + direction * (event.clientX - drag.current.x),
        );
      }}
      onLostPointerCapture={() => {
        drag.current = undefined;
        onResizingChange(false);
      }}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        resize(
          event.key === "Home"
            ? minimum
            : event.key === "End"
              ? maximum
              : value + (event.key === "ArrowRight" ? 16 : -16) * direction,
        );
      }}
    />
  );
}

const dottedBackground = style({
  backgroundColor: colors.gray[1],
  backgroundImage: `radial-gradient(${colors.grayAlpha[3]} 1px, transparent 1px)`,
  backgroundSize: "12px 12px",
});

const styles = {
  page: style({
    height: "100dvh",
    display: "flex",
    flexDirection: "column",
    backgroundColor: backgroundColor.app,
    overflow: "hidden",
  }),
  header: style({
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.value(4),
    padding: "16px 20px",
    borderBottom: `1px solid ${borderColor.border}`,
    flexShrink: 0,
  }),
  content: style(motion.standard("grid-template-columns"), {
    position: "relative",
    display: "grid",
    gridTemplateColumns:
      "var(--flow-tree-width) minmax(0, 1fr) var(--flow-preview-width)",
    minHeight: 0,
    flex: 1,
    "&[data-resizing='true']": {
      transition: "none",
      userSelect: "none",
      cursor: "col-resize",
    },
    "@media (max-width: 900px)": {
      gridTemplateColumns: "minmax(0, 1fr)",
      gridTemplateRows: "minmax(240px, 40dvh) minmax(0, 1fr)",
    },
    "@media (prefers-reduced-motion: reduce)": { transition: "none" },
  }),
  collapsed: style({
    gridTemplateColumns: "0px minmax(0, 1fr) var(--flow-preview-width)",
    "@media (max-width: 900px)": { gridTemplateColumns: "minmax(0, 1fr)" },
  }),
  sidebarToggle: style(motion.standard("left"), {
    "&&": {
      position: "absolute",
      left: "calc(var(--flow-tree-width) - 40px)",
      top: 10,
      zIndex: 30,
    },
    "@media (prefers-reduced-motion: reduce)": { transition: "none" },
  }),
  toggleCollapsed: style({ "&&": { left: 12 } }),
  treeClosed: style({ transform: "translateX(-100%)", opacity: 0 }),
  treeSlot: style({
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    "@media (max-width: 900px)": {
      position: "absolute",
      left: 0,
      top: 0,
      height: "40dvh",
      width: "var(--flow-tree-width)",
      zIndex: 20,
      pointerEvents: "none",
    },
  }),
  tree: style(motion.standard("transform", "opacity"), {
    width: "var(--flow-tree-width)",
    height: "100%",
    boxSizing: "border-box",
    overflow: "auto",
    padding: "48px 8px 12px",
    backgroundColor: backgroundColor.element,
    borderRight: `1px solid ${borderColor.border}`,
    "@media (max-width: 900px)": { pointerEvents: "auto" },
    "@media (prefers-reduced-motion: reduce)": { transition: "none" },
  }),
  treeList: style({
    listStyle: "none",
    margin: 0,
    padding: 0,
    "& ul": {
      marginLeft: 8,
      paddingLeft: 6,
      borderLeft: `1px solid ${borderColor.border}`,
    },
  }),
  treeRow: style(radius.sm, {
    display: "flex",
    alignItems: "center",
    gap: 4,
    paddingRight: spacing.value(3),
    "&[data-selected='true']": {
      backgroundColor: backgroundColor.elementHover,
    },
  }),
  treeButton: style({
    "&&": {
      flex: 1,
      minWidth: 0,
      height: "auto",
      minHeight: 32,
      whiteSpace: "normal",
      textAlign: "left",
      justifyContent: "start",
      padding: "6px",
      fontSize: 12,
    },
    "&&[aria-current='step']": {
      color: colors.accent[11],
    },
  }),
  mapPane: style({
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
    borderRight: `1px solid ${borderColor.border}`,
  }),
  map: style(dottedBackground, {
    flex: 1,
    overflow: "auto",
    minHeight: 0,
    position: "relative",
  }),
  graph: style(motion.standard("transform"), {
    position: "relative",
    transformOrigin: "top left",
    "@media (prefers-reduced-motion: reduce)": { transition: "none" },
  }),
  edge: style(motion.standard("stroke", "stroke-width"), {
    "@media (prefers-reduced-motion: reduce)": { transition: "none" },
  }),
  node: style(radius.lg, {
    position: "absolute",
    display: "flex",
    flexDirection: "column",
    padding: thumbnailPadding,
    gap: thumbnailGap,
    "&[data-selected='true'] [data-flow-title]": {
      color: colors.accent[11],
      fontWeight: 600,
    },
    "&:hover": { backgroundColor: backgroundColor.elementHover },
  }),
  nodeBody: style({ position: "relative", flexShrink: 0 }),
  thumbnail: style(motion.standard("opacity"), {
    position: "absolute",
    inset: 0,
    overflow: "clip",
    overflowClipMargin: spacing.value(2),
    pointerEvents: "none",
    "&[data-reviewed='true']": { opacity: 0.35 },
    "@media (prefers-reduced-motion: reduce)": { transition: "none" },
  }),
  reviewedMark: style(
    radius.circle,
    shadow.subtle,
    text({ color: "onAccent" }),
    {
      position: "absolute",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      width: 40,
      height: 40,
      display: "grid",
      placeItems: "center",
      backgroundColor: colors.green[9],
      pointerEvents: "none",
    },
  ),
  hit: style(focusRing("&&:focus-visible"), {
    "&&": {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      padding: 0,
      backgroundColor: "transparent",
      boxShadow: "none",
      border: "none",
      borderRadius: 0,
      cursor: "pointer",
    },
    "&&:hover:not(:disabled), &&[data-hovered], &&[data-pressed]": {
      backgroundColor: "transparent",
    },
    "&&:focus-visible": { position: "absolute" },
  }),
  nodeHeader: style({
    minHeight: thumbnailHeaderHeight,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: spacing.value(3),
    pointerEvents: "none",
    "& > [role='group']": {
      pointerEvents: "auto",
      position: "relative",
      zIndex: 2,
    },
  }),
  reviewCheckbox: style({
    flexShrink: 0,
    "& label > span:last-child": {
      position: "absolute",
      width: 1,
      height: 1,
      overflow: "hidden",
      clipPath: "inset(50%)",
      whiteSpace: "nowrap",
    },
  }),
  preview: style({
    minWidth: 0,
    minHeight: 0,
    overflow: "auto",
    padding: 20,
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr)",
    gap: 16,
    backgroundColor: backgroundColor.element,
  }),
  previewPanel: style(
    flex({
      direction: "column",
      alignItems: "center",
      justifyContent: "start",
    }),
    dottedBackground,
    spacing.padding({ all: 8 }),
    border([], "outline"),
    radius.xl,
    {
      width: "100%",
      justifySelf: "center",
      minWidth: 0,
      minHeight: 0,
      overflow: "auto",
    },
  ),
  navigationButton: style({
    "&&": {
      height: "auto",
      minHeight: 32,
      maxWidth: "100%",
      whiteSpace: "normal",
      textAlign: "left",
    },
  }),
  resizeHandle: style(focusRing(), {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 8,
    zIndex: 25,
    cursor: "col-resize",
    touchAction: "none",
    "&[data-side='left']": { left: "calc(var(--flow-tree-width) - 4px)" },
    "&[data-side='right']": { right: "calc(var(--flow-preview-width) - 4px)" },
    "&:hover, &:focus-visible": { backgroundColor: colors.accentAlpha[4] },
    // Maui's focus ring uses relative positioning; handles must stay outside the grid flow.
    "&:focus-visible": { position: "absolute", zIndex: 25 },
    "@media (max-width: 900px)": { display: "none" },
  }),
  scene: style({
    display: "grid",
    height: "100%",
    minHeight: 0,
    gridTemplateRows: "auto minmax(0, max-content) auto",
    alignContent: "start",
    gap: 16,
  }),
};
