import { useEffect, useRef, useState } from "react";
import * as errore from "errore";
import type {
  WorkspaceSearchHit,
  WorkspaceSearchResponse,
} from "@get-halo/client";
import { backgroundColor, colors, radius, shadow, text } from "maui";
import { style, useStyles } from "purse-styles";
import { useApi } from "./api/ApiProvider.js";
import { useWorkspacePanes } from "./panes/WorkspacePanesProvider.js";

class SearchRequestError extends errore.createTaggedError({
  name: "SearchRequestError",
  message: "Could not search the workspace",
}) {}

export function GlobalSearch() {
  const api = useApi();
  const workspace = useWorkspacePanes();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<WorkspaceSearchResponse>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const backdrop = useStyles(styles.backdrop);
  const panel = useStyles(styles.panel);
  const field = useStyles(styles.field);
  const list = useStyles(styles.list);
  const hitStyle = useStyles(styles.hit);
  const title = useStyles(styles.title);
  const snippet = useStyles(styles.snippet);
  const match = useStyles(styles.match);
  const status = useStyles(styles.status);

  useEffect(() => {
    const listener = (event: Event) => {
      // SAFETY: Halo's `halo:find` dispatcher supplies this event detail.
      if ((event as CustomEvent<{ kind: string }>).detail.kind !== "global")
        return;
      setOpen(true);
      requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener("halo:find", listener);
    return () => window.removeEventListener("halo:find", listener);
  }, []);

  useEffect(() => {
    if (!open || query.trim().length === 0) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void api.workspace
        .search({ query }, { signal: controller.signal })
        .then((found) => {
          if (controller.signal.aborted) return;
          setLoading(false);
          setResponse(found);
        })
        .catch((cause) => {
          if (controller.signal.aborted) return;
          setLoading(false);
          setError(new SearchRequestError({ cause }).message);
        });
    }, 300);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [api, open, query]);

  function openHit(hit: WorkspaceSearchHit) {
    const path =
      hit.kind === "file"
        ? `/files/${hit.path!.split("/").map(encodeURIComponent).join("/")}`
        : `/sessions/${hit.sessionId}`;
    workspace.open({ path, newTab: true });
    setOpen(false);
    if (hit.source !== "content") return;
    requestAnimationFrame(() =>
      window.dispatchEvent(
        new CustomEvent("halo:find", {
          detail: {
            kind: "tab",
            path,
            query,
            index: hit.matchIndex,
            segmentId: hit.segmentId,
            offset: hit.offset,
          },
        }),
      ),
    );
  }

  if (!open) return undefined;
  return (
    <div
      className={backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <section
        className={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Search workspace"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <input
          ref={input}
          className={field}
          aria-label="Search workspace"
          placeholder="Search files and sessions"
          maxLength={200}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setResponse(undefined);
            setError(undefined);
            setLoading(event.target.value.trim().length > 0);
          }}
        />
        {query.trim().length === 0 ? (
          <p className={status}>Search saved files and conversations.</p>
        ) : error !== undefined ? (
          <p role="alert" className={status}>
            {error}
          </p>
        ) : loading ? (
          <p className={status}>Searching…</p>
        ) : response?.hits.length === 0 ? (
          <p className={status}>No results for “{query}”.</p>
        ) : undefined}
        {response !== undefined && response.hits.length > 0 && (
          <ul className={list} aria-label="Search results">
            {response.hits.map((hit, index) => (
              <li
                key={`${hit.kind}-${hit.path ?? hit.sessionId}-${hit.source}-${hit.matchIndex}-${index}`}
              >
                <button
                  type="button"
                  className={hitStyle}
                  onClick={() => openHit(hit)}
                >
                  <span className={title}>
                    {hit.kind === "file"
                      ? hit.source === "name"
                        ? "File name"
                        : "File"
                      : hit.source === "name"
                        ? "Session title"
                        : "Session"}{" "}
                    · {hit.title}
                  </span>
                  <span className={snippet}>
                    {hit.snippet.slice(0, hit.snippetMatch.start)}
                    <mark className={match}>
                      {hit.snippet.slice(
                        hit.snippetMatch.start,
                        hit.snippetMatch.end,
                      )}
                    </mark>
                    {hit.snippet.slice(hit.snippetMatch.end)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {response !== undefined &&
          (response.skippedOversizedFiles > 0 || response.truncated) && (
            <p className={status}>
              {response.skippedOversizedFiles > 0
                ? `${response.skippedOversizedFiles} text file${response.skippedOversizedFiles === 1 ? "" : "s"} over 5 MiB skipped. `
                : ""}
              {response.truncated ? "Showing the first results." : ""}
            </p>
          )}
      </section>
    </div>
  );
}

const styles = {
  backdrop: style({
    position: "fixed",
    inset: 0,
    zIndex: 90,
    backgroundColor: "rgba(0, 0, 0, 0.38)",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    padding: "min(15vh, 120px) 16px 16px",
  }),
  panel: style(shadow.strong, radius.lg, {
    width: "min(680px, 100%)",
    maxHeight: "75dvh",
    display: "flex",
    flexDirection: "column",
    backgroundColor: backgroundColor.app,
    overflow: "hidden",
    padding: 12,
  }),
  field: style(text({ size: "md" }), {
    width: "100%",
    padding: "10px 12px",
    color: colors.gray[12],
    backgroundColor: backgroundColor.element,
    border: `1px solid ${colors.gray[7]}`,
    borderRadius: 6,
  }),
  list: style({
    margin: "8px 0 0",
    padding: 0,
    listStyle: "none",
    overflowY: "auto",
  }),
  hit: style({
    width: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "start",
    gap: 3,
    padding: "9px 10px",
    border: 0,
    borderRadius: 6,
    textAlign: "left",
    color: colors.gray[12],
    backgroundColor: "transparent",
    cursor: "pointer",
    "&:hover": { backgroundColor: backgroundColor.elementHover },
  }),
  title: style(text({ size: "sm", fontWeight: 600, color: "highContrast" })),
  snippet: style(text({ size: "xs", color: "lowContrast" }), {
    maxWidth: "100%",
    lineHeight: 1.5,
    overflowWrap: "anywhere",
  }),
  match: style({
    backgroundColor: colors.amber[5],
    color: colors.gray[12],
    borderRadius: 2,
  }),
  status: style(text({ size: "sm", color: "lowContrast" }), {
    margin: "10px 4px",
  }),
};
