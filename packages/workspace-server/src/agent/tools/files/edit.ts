import path from "node:path";
import * as errore from "errore";
import type { FilesystemService } from "../../../filesystem/FilesystemService.js";

export class FilesEditError extends errore.createTaggedError({
  name: "FilesEditError",
  message: "Failed to edit $path",
}) {}

function stripBom(content: string) {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

function detectLineEnding(content: string) {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLF(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n") {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export async function editFile(args: {
  filesystem: FilesystemService;
  cwd: string;
  input: {
    path: string;
    oldText: string;
    newText: string;
    replaceAll?: boolean;
  };
}) {
  const { path: filePath, oldText, newText, replaceAll = false } = args.input;
  if (oldText === newText) {
    return new FilesEditError({
      path: filePath,
      cause: new Error("oldText and newText must be different"),
    });
  }
  if (oldText.length === 0) {
    return new FilesEditError({
      path: filePath,
      cause: new Error("oldText must not be empty"),
    });
  }

  const absolutePath = path.resolve(args.cwd, filePath);
  const raw = await args.filesystem.readFile(absolutePath, "utf8");
  if (raw instanceof Error) {
    return new FilesEditError({ path: filePath, cause: raw });
  }

  const { bom, text: noBomContent } = stripBom(raw);
  const lineEnding = detectLineEnding(noBomContent);
  const normalizedContent = normalizeToLF(noBomContent);
  const normalizedOldText = normalizeToLF(oldText);
  const normalizedNewText = normalizeToLF(newText);
  const occurrences = normalizedContent.split(normalizedOldText).length - 1;

  if (occurrences === 0) {
    return new FilesEditError({
      path: filePath,
      cause: new Error(
        `oldText not found in ${filePath}. Make sure it matches the file content exactly, including whitespace and indentation.`,
      ),
    });
  }

  if (!replaceAll && occurrences > 1) {
    return new FilesEditError({
      path: filePath,
      cause: new Error(
        `Found ${occurrences} occurrences of the text in ${filePath}. The text must be unique. Provide more context, or pass replaceAll: true.`,
      ),
    });
  }

  const newContent = replaceAll
    ? normalizedContent.split(normalizedOldText).join(normalizedNewText)
    : normalizedContent.replace(normalizedOldText, normalizedNewText);
  const finalContent = bom + restoreLineEndings(newContent, lineEnding);

  const written = await args.filesystem.writeFile(
    absolutePath,
    finalContent,
    "utf8",
  );
  if (written instanceof Error) {
    return new FilesEditError({ path: filePath, cause: written });
  }

  return {
    path: filePath,
    replacements: replaceAll ? occurrences : 1,
  };
}
