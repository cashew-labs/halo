import path from "node:path";
import * as errore from "errore";
import { marked, type Token, type Tokens } from "marked";
import type {
  HaloEntry,
  WorkspaceSearchHit,
  WorkspaceSearchResponse,
} from "@get-halo/client";
import type { NativeConnection } from "../database/DatabaseService.js";
import { decodeSessionJson } from "../database/sessionSchema.js";
import type { WorkspaceService } from "./WorkspaceService.js";

const maxFileBytes = 5 * 1024 * 1024;
const maxFileHits = 60;
const maxSessionHits = 40;
const pageSize = 100;
const excludedExtensions = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".docm",
  ".xls",
  ".xlsx",
  ".xlsm",
  ".ppt",
  ".pptx",
  ".pptm",
  ".odt",
  ".ods",
  ".odp",
  ".odg",
  ".rtf",
  ".epub",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".heic",
  ".heif",
  ".avif",
  ".bmp",
  ".tif",
  ".tiff",
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".m4a",
  ".aac",
  ".mp4",
  ".m4v",
  ".webm",
  ".mov",
  ".zip",
  ".gz",
  ".tar",
]);

export class WorkspaceSearchError extends errore.createTaggedError({
  name: "WorkspaceSearchError",
  message: "Workspace search failed",
}) {}

function occurrences(text: string, needle: string, limit: number) {
  const folded = text.toLocaleLowerCase();
  const offsets: number[] = [];
  for (
    let start = folded.indexOf(needle);
    start !== -1 && offsets.length < limit;
    start = folded.indexOf(needle, start + needle.length)
  )
    offsets.push(start);
  return offsets;
}

function inlineMarkdownText(tokens: Token[]): string {
  return tokens
    .map((token) => {
      if (token.type === "image" || token.type === "br") return "";
      if ("tokens" in token && Array.isArray(token.tokens))
        return inlineMarkdownText(token.tokens);
      if (
        token.type === "text" ||
        token.type === "escape" ||
        token.type === "codespan"
      )
        return token.text;
      return "";
    })
    .join("");
}

function markdownTextblocks(tokens: Token[]): string[] {
  return tokens.flatMap((token) => {
    if (token.type === "list")
      // SAFETY: Marked's built-in list tokens have typed list items; no extensions are registered.
      return (token as Tokens.List).items.flatMap((item) =>
        markdownTextblocks(item.tokens),
      );
    if (token.type === "blockquote")
      return markdownTextblocks(token.tokens ?? []);
    if (token.type === "code") return [token.text];
    if (
      token.type === "heading" ||
      token.type === "paragraph" ||
      token.type === "text"
    )
      return [inlineMarkdownText(token.tokens ?? [])];
    return [];
  });
}

function markdownMatches(content: string, needle: string) {
  const blocks = markdownTextblocks(marked.lexer(content));
  const text = blocks.join("\n");
  const offsets: number[] = [];
  let blockStart = 0;
  for (const block of blocks) {
    for (const offset of occurrences(block, needle, 3 - offsets.length))
      offsets.push(blockStart + offset);
    if (offsets.length === 3) break;
    blockStart += block.length + 1;
  }
  return { text, offsets };
}

function snippet(text: string, start: number, length: number) {
  const from = Math.max(0, start - 100);
  const to = Math.min(text.length, start + length + 140);
  const before = `${from > 0 ? "…" : ""}${text.slice(from, start).replace(/\s+/g, " ")}`;
  const match = text.slice(start, start + length).replace(/\s+/g, " ");
  const after = `${text.slice(start + length, to).replace(/\s+/g, " ")}${to < text.length ? "…" : ""}`;
  return {
    snippet: `${before}${match}${after}`,
    snippetMatch: { start: before.length, end: before.length + match.length },
  };
}

function messageSegments(entry: HaloEntry) {
  if (entry.type !== "message") return [];
  const message = entry.message;
  if (message.role === "user") {
    const text =
      message.displayText ??
      (Array.isArray(message.content)
        ? message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("")
        : message.content);
    return [{ text, id: entry.id }];
  }
  if (message.role !== "assistant") return [];
  const segments: { text: string; id: string }[] = [];
  for (const part of message.content) {
    if (part.type === "text" && part.text.length > 0)
      segments.push({
        text: part.text,
        id: `text-${entry.id}-${segments.length}`,
      });
  }
  return segments;
}

export class WorkspaceSearch {
  private readonly workspace: WorkspaceService;
  private readonly database: NativeConnection;

  constructor(ctx: {
    workspace: WorkspaceService;
    database: NativeConnection;
  }) {
    this.workspace = ctx.workspace;
    this.database = ctx.database;
  }

  async search(
    query: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceSearchResponse | WorkspaceSearchError> {
    if (query.trim().length === 0)
      return { hits: [], skippedOversizedFiles: 0, truncated: false };
    const needle = query.slice(0, 200).toLocaleLowerCase();
    const [files, sessions] = await Promise.all([
      this.searchFiles(needle, signal),
      this.searchSessions(needle, signal),
    ]);
    if (files instanceof Error) return files;
    if (sessions instanceof Error) return sessions;
    return {
      hits: [...files.hits, ...sessions.hits],
      skippedOversizedFiles: files.skippedOversizedFiles,
      truncated: files.truncated || sessions.truncated,
    };
  }

  private async searchFiles(needle: string, signal?: AbortSignal) {
    const paths = await this.workspace.listPaths();
    if (paths instanceof Error)
      return new WorkspaceSearchError({ cause: paths });
    const filePaths = paths.filter(
      (filePath) =>
        !filePath.endsWith("/") &&
        !excludedExtensions.has(path.extname(filePath).toLowerCase()),
    );
    const fileHits: WorkspaceSearchHit[] = [];
    let nextPath = 0;
    let skippedOversizedFiles = 0;
    let truncated = false;

    const readNext = async () => {
      while (nextPath < filePaths.length) {
        if (signal?.aborted) break;
        const filePath = filePaths[nextPath++]!;
        const file = await this.workspace.readSearchText(
          filePath,
          maxFileBytes,
        );
        if (file instanceof Error)
          return new WorkspaceSearchError({ cause: file });
        if (file.kind === "oversized") {
          skippedOversizedFiles++;
          continue;
        }
        if (file.kind === "unsupported" || file.kind === "missing") continue;
        const content = file.content;
        const name = path.basename(filePath);
        const nameOffsets = occurrences(name, needle, 1);
        const isMarkdown = /\.(?:md|markdown)$/i.test(filePath);
        const searchable = isMarkdown
          ? markdownMatches(content, needle)
          : { text: content, offsets: occurrences(content, needle, 3) };
        const hits: WorkspaceSearchHit[] = [
          ...nameOffsets.slice(0, 1).map((offset) => ({
            kind: "file" as const,
            path: filePath,
            title: filePath,
            snippet: filePath,
            snippetMatch: {
              start: filePath.length - name.length + offset,
              end: filePath.length - name.length + offset + needle.length,
            },
            source: "name" as const,
            matchIndex: 0,
          })),
          ...searchable.offsets.map((offset, matchIndex) => ({
            kind: "file" as const,
            path: filePath,
            title: filePath,
            ...snippet(searchable.text, offset, needle.length),
            source: "content" as const,
            matchIndex,
            ...(!isMarkdown && {
              segmentId: filePath,
              offset,
            }),
          })),
        ];
        for (const hit of hits) {
          if (fileHits.length >= maxFileHits) {
            truncated = true;
            break;
          }
          fileHits.push(hit);
        }
        if (truncated) break;
      }
    };
    const workers = await Promise.all(
      Array.from({ length: 8 }, async () => await readNext()),
    );
    const fileError = workers.find((result) => result instanceof Error);
    if (fileError instanceof Error) return fileError;
    return {
      hits: fileHits,
      skippedOversizedFiles,
      truncated,
    };
  }

  private async searchSessions(needle: string, signal?: AbortSignal) {
    const sessions = await this.database.access((connection) => {
      // SAFETY: The projection matches Halo's session and session-name tables.
      return connection
        .prepare(
          "SELECT s.id, v.payload AS name FROM halo_sessions s LEFT JOIN halo_session_values v ON v.session_id = s.id AND v.namespace = 'pi.session.name' AND v.key = '' ORDER BY s.id",
        )
        .all() as { id: string; name: string | null }[];
    });
    if (sessions instanceof Error)
      return new WorkspaceSearchError({ cause: sessions });
    const hits: WorkspaceSearchHit[] = [];
    let truncated = false;
    for (const session of sessions) {
      if (signal?.aborted || truncated) break;
      let title =
        session.name === null ? "" : decodeSessionJson<string>(session.name);
      let seq = 0;
      let matchIndex = 0;
      const titleOffset = title.toLocaleLowerCase().indexOf(needle);
      if (titleOffset !== -1)
        hits.push({
          kind: "session",
          sessionId: session.id,
          title,
          snippet: title,
          snippetMatch: {
            start: titleOffset,
            end: titleOffset + needle.length,
          },
          source: "name",
          matchIndex: 0,
        });
      while (true) {
        if (signal?.aborted) break;
        const page = await this.database.access((connection) => {
          // SAFETY: The projection matches Halo's persisted session entry table.
          return connection
            .prepare(
              "SELECT seq, payload FROM halo_session_entries WHERE session_id = ? AND type = 'message' AND seq > ? ORDER BY seq LIMIT ?",
            )
            .all(session.id, seq, pageSize) as {
            seq: number;
            payload: string;
          }[];
        });
        if (page instanceof Error)
          return new WorkspaceSearchError({ cause: page });
        if (page.length === 0) break;
        for (const row of page) {
          const entry = decodeSessionJson<HaloEntry>(row.payload);
          for (const segment of messageSegments(entry)) {
            if (
              title.length === 0 &&
              entry.type === "message" &&
              entry.message.role === "user"
            ) {
              title = segment.text.slice(0, 120);
            }
            for (const offset of occurrences(
              segment.text,
              needle,
              maxSessionHits - hits.length + 1,
            )) {
              if (hits.length >= maxSessionHits) {
                truncated = true;
                break;
              }
              hits.push({
                kind: "session",
                sessionId: session.id,
                title: title || "Session",
                ...snippet(segment.text, offset, needle.length),
                source: "content",
                matchIndex: matchIndex++,
                segmentId: segment.id,
                offset,
              });
            }
            if (truncated) break;
          }
          if (truncated) break;
        }
        seq = page.at(-1)!.seq;
        if (page.length < pageSize || truncated) break;
      }
    }
    return { hits, truncated };
  }
}
