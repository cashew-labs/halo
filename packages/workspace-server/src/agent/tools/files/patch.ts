/**
 * Codex apply_patch format parser and applier.
 *
 * Ported from: https://github.com/openai/codex/tree/main/codex-rs/apply-patch
 *
 * The patch format:
 *   *** Begin Patch
 *   *** Add File: <path>        — create a new file, following lines prefixed with +
 *   *** Delete File: <path>     — remove a file
 *   *** Update File: <path>     — modify a file in place
 *   *** Move to: <new-path>     — (optional) rename after updating
 *   @@ [context header]         — hunk header, context lines, +/- diffs
 *   *** End of File             — (optional) marks end-of-file for matching
 *   *** End Patch
 */

import { resolve, dirname } from "node:path";
import * as errore from "errore";
import type {
  FilesystemError,
  FilesystemService,
} from "../../../filesystem/FilesystemService.js";

// ── Types ────────────────────────────────────────────────────────────────

interface UpdateFileChunk {
  changeContext: string[];
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
}

interface PlannedReplacement {
  path: string;
  startIdx: number;
  oldLen: number;
  newSegment: string[];
}

interface PlannedUpdate {
  path: string;
  movePath: string | undefined;
  replacements: PlannedReplacement[];
}

type Hunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | {
      type: "update";
      path: string;
      movePath: string | undefined;
      chunks: UpdateFileChunk[];
    };

// ── Markers ──────────────────────────────────────────────────────────────

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT = "@@ ";
const EMPTY_CHANGE_CONTEXT = "@@";

// ── Parser ───────────────────────────────────────────────────────────────

function lineAt(lines: readonly string[], index: number): string {
  const line = lines[index];
  if (line === undefined) {
    throw new Error(`Unexpected end of patch at line ${index + 1}`);
  }
  return line;
}

function parsePatch(patch: string): Hunk[] {
  let lines = patch.trim().split("\n");

  // Lenient mode: strip heredoc wrapper if present
  const maybeLast = lines[lines.length - 1];
  if (
    lines.length >= 4 &&
    maybeLast !== undefined &&
    (lines[0] === "<<EOF" ||
      lines[0] === "<<'EOF'" ||
      lines[0] === '<<"EOF"') &&
    maybeLast.endsWith("EOF")
  ) {
    lines = lines.slice(1, -1);
  }

  const first = lines[0]?.trim();
  const last = lines[lines.length - 1]?.trim();

  if (first !== BEGIN_PATCH) {
    throw new Error(
      `Invalid patch: first line must be '${BEGIN_PATCH}', got '${first}'`,
    );
  }
  if (last !== END_PATCH) {
    throw new Error(
      `Invalid patch: last line must be '${END_PATCH}', got '${last}'`,
    );
  }

  const hunks: Hunk[] = [];
  let i = 1;
  const end = lines.length - 1;

  while (i < end) {
    const line = lineAt(lines, i).trim();

    if (line.startsWith(ADD_FILE)) {
      const path = line.slice(ADD_FILE.length);
      let contents = "";
      i++;
      while (i < end && lineAt(lines, i).startsWith("+")) {
        contents += lineAt(lines, i).slice(1) + "\n";
        i++;
      }
      hunks.push({ type: "add", path, contents });
    } else if (line.startsWith(DELETE_FILE)) {
      hunks.push({ type: "delete", path: line.slice(DELETE_FILE.length) });
      i++;
    } else if (line.startsWith(UPDATE_FILE)) {
      const path = line.slice(UPDATE_FILE.length);
      i++;

      // Optional move
      let movePath: string | undefined = undefined;
      if (i < end && lineAt(lines, i).startsWith(MOVE_TO)) {
        movePath = lineAt(lines, i).slice(MOVE_TO.length);
        i++;
      }

      const chunks: UpdateFileChunk[] = [];
      while (i < end) {
        // Skip blank lines between chunks
        if (lineAt(lines, i).trim() === "") {
          i++;
          continue;
        }
        // Stop if we hit the next file operation
        if (lineAt(lines, i).startsWith("***")) break;

        const [chunk, linesConsumed] = parseUpdateChunk(
          lines,
          i,
          end,
          chunks.length === 0,
        );
        chunks.push(chunk);
        i += linesConsumed;
      }

      if (chunks.length === 0) {
        throw new Error(`Update file hunk for '${path}' is empty`);
      }

      hunks.push({ type: "update", path, movePath, chunks });
    } else {
      throw new Error(`Unexpected line at position ${i + 1}: '${line}'`);
    }
  }

  return hunks;
}

function parseUpdateChunk(
  lines: string[],
  start: number,
  end: number,
  allowMissingContext: boolean,
): [UpdateFileChunk, number] {
  let i = start;
  const changeContext: string[] = [];
  let sawContextMarker = false;

  while (i < end) {
    if (lineAt(lines, i) === EMPTY_CHANGE_CONTEXT) {
      sawContextMarker = true;
      i++;
      continue;
    }
    if (lineAt(lines, i).startsWith(CHANGE_CONTEXT)) {
      sawContextMarker = true;
      changeContext.push(lineAt(lines, i).slice(CHANGE_CONTEXT.length));
      i++;
      continue;
    }
    break;
  }

  if (!sawContextMarker && !allowMissingContext) {
    throw new Error(
      `Expected @@ context marker at line ${i + 1}, got: '${lineAt(lines, i)}`,
    );
  }

  const oldLines: string[] = [];
  const newLines: string[] = [];
  let isEndOfFile = false;
  let parsedDiffLines = 0;

  while (i < end) {
    const line = lineAt(lines, i);

    if (line === EOF_MARKER) {
      if (parsedDiffLines === 0) {
        throw new Error(
          `Update hunk at line ${start + 1} has no diff lines before End of File`,
        );
      }
      isEndOfFile = true;
      i++;
      break;
    }

    const ch = line[0];
    if (ch === " ") {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    } else if (ch === "+") {
      newLines.push(line.slice(1));
    } else if (ch === "-") {
      oldLines.push(line.slice(1));
    } else if (line === "") {
      // Empty line treated as empty context
      oldLines.push("");
      newLines.push("");
    } else if (
      line.startsWith(CHANGE_CONTEXT) ||
      line === EMPTY_CHANGE_CONTEXT
    ) {
      // Start of the next hunk. Multiple adjacent @@ markers are consumed
      // together at the beginning of a hunk for Amp-style context narrowing.
      break;
    } else {
      if (parsedDiffLines === 0) {
        throw new Error(
          `Unexpected line in update hunk at line ${i + 1}: '${line}'. ` +
            `Lines must start with ' ', '+', or '-'`,
        );
      }
      // Start of next hunk or file op
      break;
    }
    parsedDiffLines++;
    i++;
  }

  return [{ changeContext, oldLines, newLines, isEndOfFile }, i - start];
}

// ── Sequence Matching ────────────────────────────────────────────────────

/**
 * Find `pattern` within `lines` starting at `start`.
 * Tries exact match, then trimmed match, then Unicode-normalized match.
 * When `eof` is true, starts searching from end of file.
 */
function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
): number | undefined {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return undefined;

  const searchStart =
    eof && lines.length >= pattern.length
      ? lines.length - pattern.length
      : start;

  // Exact match
  for (let i = searchStart; i <= lines.length - pattern.length; i++) {
    if (pattern.every((p, j) => lineAt(lines, i + j) === p)) return i;
  }

  // Trim-end match
  for (let i = searchStart; i <= lines.length - pattern.length; i++) {
    if (pattern.every((p, j) => lineAt(lines, i + j).trimEnd() === p.trimEnd()))
      return i;
  }

  // Full trim match
  for (let i = searchStart; i <= lines.length - pattern.length; i++) {
    if (pattern.every((p, j) => lineAt(lines, i + j).trim() === p.trim()))
      return i;
  }

  // Unicode-normalized match
  for (let i = searchStart; i <= lines.length - pattern.length; i++) {
    if (
      pattern.every((p, j) => normalise(lineAt(lines, i + j)) === normalise(p))
    )
      return i;
  }

  return undefined;
}

function normalise(s: string): string {
  return s
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C-\u201F]/g, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function seekContextHeader(
  lines: string[],
  header: string,
  start: number,
): number | undefined {
  const exact = seekSequence(lines, [header], start, false);
  if (exact !== undefined) return exact;

  const needle = normalise(header);
  if (!needle) return start;
  for (let i = start; i < lines.length; i++) {
    if (normalise(lineAt(lines, i)).includes(needle)) return i;
  }

  return undefined;
}

// ── Applier ──────────────────────────────────────────────────────────────

function planUpdateChunks(
  originalContent: string,
  path: string,
  chunks: UpdateFileChunk[],
): PlannedUpdate {
  let originalLines = originalContent.split("\n");
  // Drop trailing empty element from final newline (matches Codex behavior)
  if (originalLines[originalLines.length - 1] === "") {
    originalLines.pop();
  }

  const replacements: PlannedReplacement[] = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    // Handle change_context: each @@ header narrows the search from the
    // previously matched point. This matches Amp's multi-@@ guidance.
    for (const context of chunk.changeContext) {
      const idx = seekContextHeader(originalLines, context, lineIndex);
      if (idx === undefined) {
        throw new Error(`Failed to find context '${context}' in ${path}`);
      }
      lineIndex = idx + 1;
    }

    if (chunk.oldLines.length === 0) {
      // Pure addition — insert after any @@ context anchors, otherwise at EOF.
      const insertionIdx =
        chunk.changeContext.length > 0
          ? lineIndex
          : originalLines[originalLines.length - 1] === ""
            ? originalLines.length - 1
            : originalLines.length;
      replacements.push({
        path,
        startIdx: insertionIdx,
        oldLen: 0,
        newSegment: chunk.newLines,
      });
      continue;
    }

    // Try to find the old lines in the file
    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = seekSequence(
      originalLines,
      pattern,
      lineIndex,
      chunk.isEndOfFile,
    );

    // Retry without trailing empty line (like Codex does)
    if (
      found === undefined &&
      pattern.length > 0 &&
      pattern[pattern.length - 1] === ""
    ) {
      pattern = pattern.slice(0, -1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(
        originalLines,
        pattern,
        lineIndex,
        chunk.isEndOfFile,
      );
    }

    if (found === undefined) {
      throw new Error(
        `Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`,
      );
    }

    replacements.push({
      path,
      startIdx: found,
      oldLen: pattern.length,
      newSegment: newSlice,
    });
    lineIndex = found + pattern.length;
  }

  replacements.sort((a, b) => a.startIdx - b.startIdx);
  return { path, movePath: undefined, replacements };
}

function applyPlannedUpdate(
  originalContent: string,
  plan: PlannedUpdate,
): string {
  let originalLines = originalContent.split("\n");
  if (originalLines[originalLines.length - 1] === "") {
    originalLines.pop();
  }

  const resultLines = [...originalLines];
  for (const replacement of plan.replacements.toReversed()) {
    resultLines.splice(
      replacement.startIdx,
      replacement.oldLen,
      ...replacement.newSegment,
    );
  }

  if (resultLines[resultLines.length - 1] !== "") {
    resultLines.push("");
  }

  return resultLines.join("\n");
}

function createPatchPlan(
  filesystem: FilesystemService,
  patchText: string,
  cwd: string,
) {
  const hunks = parsePatch(patchText);

  if (hunks.length === 0) {
    throw new Error("No files were modified.");
  }

  const updates: PlannedUpdate[] = [];
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const hunk of hunks) {
    switch (hunk.type) {
      case "add":
        added.push(hunk.path);
        break;
      case "delete":
        deleted.push(hunk.path);
        break;
      case "update": {
        const original = filesystemValue(
          filesystem.readFileSync(resolve(cwd, hunk.path), "utf8"),
        );
        const plan = planUpdateChunks(original, hunk.path, hunk.chunks);
        plan.movePath = hunk.movePath;
        updates.push(plan);
        modified.push(hunk.movePath ?? hunk.path);
        break;
      }
    }
  }

  return { hunks, updates, added, modified, deleted };
}

function applyPatch(
  filesystem: FilesystemService,
  patchText: string,
  cwd: string,
) {
  const plan = createPatchPlan(filesystem, patchText, cwd);

  for (const hunk of plan.hunks) {
    const absPath = resolve(cwd, hunk.path);

    switch (hunk.type) {
      case "add": {
        const dir = dirname(absPath);
        if (!filesystem.exists(dir)) {
          filesystemValue(filesystem.makeDirectorySync(dir));
        }
        filesystemValue(filesystem.writeFileSync(absPath, hunk.contents));
        break;
      }

      case "delete": {
        filesystemValue(filesystem.unlinkSync(absPath));
        break;
      }

      case "update": {
        const update = plan.updates.find(
          (candidate) => candidate.path === hunk.path,
        );
        if (!update) throw new Error(`Missing update plan for ${hunk.path}`);
        const original = filesystemValue(
          filesystem.readFileSync(absPath, "utf8"),
        );
        const newContent = applyPlannedUpdate(original, update);

        const dest = hunk.movePath ? resolve(cwd, hunk.movePath) : absPath;
        const destDir = dirname(dest);
        if (!filesystem.exists(destDir)) {
          filesystemValue(filesystem.makeDirectorySync(destDir));
        }

        filesystemValue(filesystem.writeFileSync(dest, newContent));
        if (hunk.movePath) {
          filesystemValue(filesystem.unlinkSync(absPath));
        }
        break;
      }
    }
  }

  return {
    added: plan.added,
    modified: plan.modified,
    deleted: plan.deleted,
  };
}

// ── Public wrapper ───────────────────────────────────────────────────────

export class FilesPatchError extends errore.createTaggedError({
  name: "FilesPatchError",
  message: "Failed to apply patch",
}) {}

export async function patchFiles(args: {
  filesystem: FilesystemService;
  cwd: string;
  input: { patchText: string };
}) {
  const preview = errore.try({
    try: () => applyPatch(args.filesystem, args.input.patchText, args.cwd),
    catch: (e) => new FilesPatchError({ cause: e }),
  });
  if (preview instanceof Error) return preview;
  return preview;
}

function filesystemValue<T>(result: T | FilesystemError): T {
  if (result instanceof Error) throw result;
  return result;
}
