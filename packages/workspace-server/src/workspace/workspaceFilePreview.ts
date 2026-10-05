import { isUtf8 } from "node:buffer";
import { extname } from "node:path";
import { imageMediaTypes, type WorkspaceFilePreview } from "@get-halo/client";

const mediaTypes = new Map<
  string,
  { kind: "image" | "pdf" | "audio" | "video"; mime: string }
>([
  ["pdf", { kind: "pdf", mime: "application/pdf" }],
  ...[...imageMediaTypes].map(
    ([extension, mime]) =>
      [extension, { kind: "image" as const, mime }] as const,
  ),
  ["mp3", { kind: "audio", mime: "audio/mpeg" }],
  ["wav", { kind: "audio", mime: "audio/wav" }],
  ["ogg", { kind: "audio", mime: "audio/ogg" }],
  ["flac", { kind: "audio", mime: "audio/flac" }],
  ["m4a", { kind: "audio", mime: "audio/mp4" }],
  ["aac", { kind: "audio", mime: "audio/aac" }],
  ["mp4", { kind: "video", mime: "video/mp4" }],
  ["m4v", { kind: "video", mime: "video/mp4" }],
  ["webm", { kind: "video", mime: "video/webm" }],
  ["mov", { kind: "video", mime: "video/quicktime" }],
]);

export function workspaceFilePreview(
  path: string,
  contents: Buffer,
): WorkspaceFilePreview {
  const media = mediaTypes.get(extname(path).slice(1).toLowerCase());
  if (media !== undefined) {
    return {
      kind: media.kind,
      file: new File([new Uint8Array(contents)], path, { type: media.mime }),
    };
  }
  if (!isUtf8(contents) || contents.includes(0)) {
    return {
      kind: "unsupported",
      reason: "This file type has no preview.",
    };
  }
  if (contents.length > 5 * 1024 * 1024) {
    return {
      kind: "unsupported",
      reason: "Text files larger than 5 MB cannot be previewed.",
    };
  }
  return { kind: "text" };
}
