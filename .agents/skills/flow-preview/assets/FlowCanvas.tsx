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
  borderColor,
  colors,
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

export type FlowNode = {
  id: string;
  title: string;
  parent?: string;
  action: string;
  /** Vertical ordering within its column; missing rows do not reserve space. */
  row: number;
  note?: string;
  render: (context: { mode: "thumbnail" | "preview" }) => ReactNode;
};

export type FlowScenario = {
  id: string;
  title: string;
  description?: string;
  notice?: string;
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

export function FlowCanvas({ scenario }: { scenario: FlowScenario }) {
  const { nodes: steps } = scenario;
  const nodeWidth = scenario.dimensions?.nodeWidth ?? 160;
  const nodeHeight = scenario.dimensions?.nodeHeight ?? 212;
  const previewWidth = scenario.dimensions?.previewWidth ?? 440;
  const contentStyle: CSSProperties & { "--flow-preview-width": string } = {
    "--flow-preview-width": `${previewWidth + 40}px`,
  };
  const columnGap = scenario.dimensions?.columnGap ?? 56;
  const rowGap = scenario.dimensions?.rowGap ?? 64;
  const label = scenario.navigationLabel ?? "Flow";
  const storageKey =
    scenario.reviewStorageKey ?? `flow-reviewed-v1:${scenario.id}`;
  const outlineId = `${scenario.id}-flow-outline`;
  const nodes = useMemo(() => {
    const positioned = new Map<string, FlowNode & { x: number; y: number }>();
    for (const step of steps) {
      positioned.set(step.id, {
        ...step,
        x: step.parent
          ? positioned.get(step.parent)!.x + nodeWidth + columnGap
          : 24,
        y: 0,
      });
    }
    // Pack each depth independently instead of reserving empty global rows.
    const nextRow = new Map<number, number>();
    // oxlint-disable-next-line unicorn/no-array-sort -- Sort a fresh array without requiring ES2023 browser APIs.
    for (const node of [...positioned.values()].sort((a, b) => a.row - b.row)) {
      const row = nextRow.get(node.x) ?? 0;
      node.y = 72 + row * (nodeHeight + rowGap);
      nextRow.set(node.x, row + 1);
    }
    return positioned;
  }, [steps, nodeWidth, nodeHeight, columnGap, rowGap]);
  const graphWidth =
    Math.max(...[...nodes.values()].map((node) => node.x)) + nodeWidth + 24;
  const graphHeight =
    Math.max(...[...nodes.values()].map((node) => node.y)) + nodeHeight + 24;
  const [selected, setSelected] = useState(scenario.initialState);
  const [revision, setRevision] = useState(0);
  const [zoom, setZoom] = useState(0.85);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const reduceMotion = useReducedMotion();
  const centered = useRef(false);
  const thumbnailRefs = useRef(new Map<string, HTMLDivElement>());
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
  const reviewCheckbox = useStyles(styles.reviewCheckbox);
  const edge = useStyles(styles.edge);
  const preview = useStyles(styles.preview);
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
        (current.y + nodeHeight / 2) * zoom - viewport.clientHeight / 2,
      ),
    });
    centered.current = true;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Reselecting/resetting a state recenters its thumbnail too.
  }, [zoom, current, revision, reduceMotion, nodeWidth, nodeHeight]);

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
              <div className={treeRow}>
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
        className={content}
        data-sidebar-open={sidebarOpen}
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
                      const startY = from.y + nodeHeight / 2;
                      const endY = to.y + nodeHeight / 2;
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
                        left: node.x,
                        top: node.y,
                        width: nodeWidth,
                        height: nodeHeight,
                      }}
                    >
                      <div className={nodeHeader}>
                        <Text size="sm" fontWeight={500} style={{ flex: 1 }}>
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
                            width: previewWidth,
                            transform: `scale(${nodeWidth / previewWidth})`,
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
          <Flex row justifyContent="between" alignItems="center" gap={4}>
            <Text size="xs" color="lowContrast">
              Interactive preview
            </Text>
            <Button size="sm" onPress={() => setRevision((value) => value + 1)}>
              Reset preview
            </Button>
          </Flex>
          <Crossfade
            contentKey={selected}
            direction="up"
            style={{ overflow: "visible" }}
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
              <div key={`${selected}-${revision}`}>
                {current.render({ mode: "preview" })}
              </div>
              <Flex column gap={4}>
                {current.parent && (
                  <Button
                    variant="quiet"
                    style={{ alignSelf: "start" }}
                    onPress={() => select(current.parent!)}
                  >
                    <ArrowLeft />
                    Previous state
                  </Button>
                )}
                {next.length > 0 && (
                  <Text size="xs" color="lowContrast">
                    Follow this flow
                  </Text>
                )}
                {next.map((step) => (
                  <Button
                    key={step.id}
                    aria-label={`Follow flow: ${step.action}`}
                    style={{
                      justifyContent: "space-between",
                      height: "auto",
                      minHeight: 32,
                      whiteSpace: "normal",
                      textAlign: "left",
                    }}
                    onPress={() => select(step.id)}
                  >
                    {step.action}
                    <ArrowRight />
                  </Button>
                ))}
              </Flex>
              {scenario.notice && (
                <Text size="xs" color="lowContrast">
                  {scenario.notice}
                </Text>
              )}
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
    gridTemplateColumns: "248px minmax(0, 1fr) var(--flow-preview-width)",
    minHeight: 0,
    flex: 1,
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
    "&&": { position: "absolute", left: 208, top: 10, zIndex: 30 },
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
      width: 248,
      zIndex: 20,
      pointerEvents: "none",
    },
  }),
  tree: style(motion.standard("transform", "opacity"), {
    width: 248,
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
  treeRow: style({ display: "flex", alignItems: "center", gap: 4 }),
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
      backgroundColor: backgroundColor.elementHover,
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
  map: style({
    flex: 1,
    overflow: "auto",
    minHeight: 0,
    position: "relative",
    backgroundImage: `radial-gradient(${borderColor.border} 1px, transparent 1px)`,
    backgroundSize: "20px 20px",
  }),
  graph: style(motion.standard("transform"), {
    position: "relative",
    transformOrigin: "top left",
    "@media (prefers-reduced-motion: reduce)": { transition: "none" },
  }),
  edge: style(motion.standard("stroke", "stroke-width"), {
    "@media (prefers-reduced-motion: reduce)": { transition: "none" },
  }),
  node: style(radius.lg, motion.standard("outline-color"), {
    position: "absolute",
    backgroundColor: backgroundColor.element,
    outline: "2px solid transparent",
    "&[data-selected='true']": { outline: `2px solid ${colors.accent[9]}` },
    "@media (prefers-reduced-motion: reduce)": { transition: "none" },
  }),
  thumbnail: style(motion.standard("opacity"), {
    position: "absolute",
    inset: 0,
    borderRadius: "inherit",
    overflow: "hidden",
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
  hit: style(
    radius.lg,
    motion.standard("border-color"),
    focusRing("&&:focus-visible"),
    {
      "&&": {
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        padding: 0,
        backgroundColor: "transparent",
        boxShadow: "none",
        border: `1px solid ${borderColor.border}`,
      },
      "&&[data-hovered]": {
        backgroundColor: "transparent",
      },
      "@media (prefers-reduced-motion: reduce)": { transition: "none" },
    },
  ),
  nodeHeader: style({
    position: "absolute",
    left: 0,
    right: 0,
    bottom: "calc(100% + 12px)",
    display: "flex",
    alignItems: "center",
    gap: spacing.value(3),
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
    display: "flex",
    flexDirection: "column",
    gap: 16,
    backgroundColor: backgroundColor.element,
    "& > *": { flexShrink: 0 },
  }),
  scene: style({
    display: "flex",
    flexDirection: "column",
    gap: 16,
  }),
};
