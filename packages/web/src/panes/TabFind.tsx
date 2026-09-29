import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { backgroundColor, colors, radius, shadow, text } from "maui";
import { style, useStyles } from "purse-styles";

type FindSegment = { id: string; text: string };
type FindSource = {
  segments: FindSegment[];
  select: (segmentId: string, start: number, end: number) => void;
  highlight?: (match: Match | undefined) => void;
};
type Match = { segmentId: string; start: number; end: number };

const FindContext = createContext<(source: FindSource | undefined) => void>(
  () => {},
);

export function useTabFindSource(source: FindSource | undefined) {
  const setSource = useContext(FindContext);
  useEffect(() => {
    setSource(source);
    return () => setSource(undefined);
  }, [setSource, source]);
}

function findMatches(segments: readonly FindSegment[], query: string): Match[] {
  if (query.length === 0) return [];
  const needle = query.toLocaleLowerCase();
  const matches: Match[] = [];
  for (const segment of segments) {
    const haystack = segment.text.toLocaleLowerCase();
    for (
      let start = haystack.indexOf(needle);
      start !== -1;
      start = haystack.indexOf(needle, start + Math.max(needle.length, 1))
    ) {
      matches.push({
        segmentId: segment.id,
        start,
        end: start + needle.length,
      });
    }
  }
  return matches;
}

export function TabFind({
  active,
  path,
  children,
}: {
  active: boolean;
  path: string;
  children: ReactNode;
}) {
  const [source, setSource] = useState<FindSource>();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [navigation, setNavigation] = useState(0);
  const [target, setTarget] = useState<{ segmentId: string; offset: number }>();
  const input = useRef<HTMLInputElement>(null);
  const bar = useStyles(styles.bar);
  const field = useStyles(styles.field);
  const button = useStyles(styles.button);
  const count = useStyles(styles.count);
  const matches = useMemo(
    () => findMatches(source?.segments ?? [], query),
    [source, query],
  );

  useEffect(() => {
    if (!active) return;
    const listener = (event: Event) => {
      // SAFETY: Halo's `halo:find` dispatcher supplies this event detail.
      const detail = (
        event as CustomEvent<{
          kind: "tab" | "global";
          query?: string;
          index?: number;
          path?: string;
          segmentId?: string;
          offset?: number;
        }>
      ).detail;
      if (
        detail.kind !== "tab" ||
        (detail.path !== undefined && detail.path !== path)
      )
        return;
      setOpen(true);
      setNavigation((current) => current + 1);
      if (detail.query !== undefined) setQuery(detail.query);
      if (detail.index !== undefined) setIndex(detail.index);
      setTarget(
        detail.segmentId !== undefined && detail.offset !== undefined
          ? { segmentId: detail.segmentId, offset: detail.offset }
          : undefined,
      );
      requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener("halo:find", listener);
    return () => window.removeEventListener("halo:find", listener);
  }, [active, path]);

  const targetIndex = useMemo(() => {
    if (target === undefined) return undefined;
    const candidates = matches
      .map((match, matchIndex) => ({ match, matchIndex }))
      .filter(({ match }) => match.segmentId === target.segmentId);
    return candidates.reduce<
      { matchIndex: number; distance: number } | undefined
    >((best, candidate) => {
      const distance = Math.abs(candidate.match.start - target.offset);
      return best === undefined || distance < best.distance
        ? { matchIndex: candidate.matchIndex, distance }
        : best;
    }, undefined)?.matchIndex;
  }, [matches, target]);
  const selectedIndex = targetIndex ?? index;
  const hasSource = source !== undefined;
  // Editing rebuilds the source; only Find navigation should move the caret.
  const selectionIntent = useMemo(
    () => ({ open, query, index, navigation, target, hasSource, path }),
    [open, query, index, navigation, target, hasSource, path],
  );
  const previousSelectionIntent = useRef<typeof selectionIntent>(undefined);
  const previousSource = useRef<FindSource>(undefined);
  const editedSinceNavigation = useRef(false);

  useEffect(() => {
    const previous = previousSelectionIntent.current;
    const selectionRequested = previous !== selectionIntent;
    previousSelectionIntent.current = selectionIntent;
    const sourceChanged =
      previousSource.current !== undefined && source !== previousSource.current;
    previousSource.current = source;
    if (open) {
      if (selectionRequested) editedSinceNavigation.current = false;
      else if (sourceChanged) editedSinceNavigation.current = true;
    }
    if (source === undefined) return;
    if (!open) {
      source.highlight?.(undefined);
      if (
        selectionRequested &&
        previous?.open === true &&
        !editedSinceNavigation.current &&
        matches.length > 0
      ) {
        const match = matches[selectedIndex % matches.length]!;
        source.select(match.segmentId, match.start, match.end);
      }
      return;
    }
    if (matches.length === 0) {
      source.highlight?.(undefined);
      return;
    }
    const match = matches[selectedIndex % matches.length]!;
    source.highlight?.(match);
    if (selectionRequested)
      source.select(match.segmentId, match.start, match.end);
    return () => source.highlight?.(undefined);
  }, [open, source, matches, selectedIndex, selectionIntent]);

  const navigate = (direction: -1 | 1) => {
    const resultCount = Math.max(matches.length, 1);
    setNavigation((current) => current + 1);
    setIndex((selectedIndex + direction + resultCount) % resultCount);
    setTarget(undefined);
  };

  return (
    <FindContext value={setSource}>
      {children}
      {open && source !== undefined && (
        <div
          className={bar}
          role="search"
          aria-label="Find in tab"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              return;
            }
            if (event.key === "Enter" && event.target === input.current) {
              event.preventDefault();
              event.stopPropagation();
              navigate(event.shiftKey ? -1 : 1);
            }
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              event.stopPropagation();
              navigate(event.key === "ArrowUp" ? -1 : 1);
            }
          }}
        >
          <input
            ref={input}
            className={field}
            aria-label="Find in tab"
            placeholder="Find"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
              setTarget(undefined);
            }}
          />
          <span className={count} aria-live="polite">
            {matches.length === 0
              ? "0 results"
              : `${(selectedIndex % matches.length) + 1} of ${matches.length}`}
          </span>
          <button
            className={button}
            type="button"
            aria-label="Previous match"
            onClick={() => navigate(-1)}
          >
            ↑
          </button>
          <button
            className={button}
            type="button"
            aria-label="Next match"
            onClick={() => navigate(1)}
          >
            ↓
          </button>
          <button
            className={button}
            type="button"
            aria-label="Close find"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>
      )}
    </FindContext>
  );
}

const styles = {
  bar: style(shadow.medium, radius.md, {
    position: "absolute",
    zIndex: 20,
    top: 8,
    right: 12,
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: 6,
    backgroundColor: backgroundColor.element,
  }),
  field: style(text({ size: "sm" }), {
    width: 200,
    minWidth: 80,
    padding: "4px 6px",
    color: colors.gray[12],
    backgroundColor: backgroundColor.app,
    border: `1px solid ${colors.gray[7]}`,
    borderRadius: 4,
  }),
  button: style(text({ size: "sm" }), {
    minWidth: 26,
    height: 26,
    border: 0,
    borderRadius: 4,
    color: colors.gray[12],
    backgroundColor: "transparent",
    cursor: "pointer",
    "&:hover": { backgroundColor: backgroundColor.elementHover },
  }),
  count: style(text({ size: "xs", color: "lowContrast" }), {
    whiteSpace: "nowrap",
  }),
};
