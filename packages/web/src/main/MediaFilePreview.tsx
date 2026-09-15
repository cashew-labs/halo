import { useCallback, useState } from "react";
import type { WorkspaceFilePreview } from "@get-halo/shared/rpc";
import { flex, spacing, text } from "maui";
import { style, useStyles } from "purse-styles";

type MediaPreview = Extract<WorkspaceFilePreview, { file: File }>;

export function MediaFilePreview({
  preview,
  path,
}: {
  preview: MediaPreview;
  path: string;
}) {
  const [failed, setFailed] = useState(false);
  const container = useStyles(
    preview.kind === "pdf" ? styles.pdf : styles.media,
  );
  const status = useStyles(styles.status);
  const attachSource = useCallback(
    (
      element: HTMLImageElement | HTMLIFrameElement | HTMLMediaElement | null,
    ) => {
      if (element === null) return;
      const url = URL.createObjectURL(preview.file);
      element.src = url;
      return () => URL.revokeObjectURL(url);
    },
    [preview.file],
  );
  if (failed)
    return (
      <p role="alert" className={status}>
        This file could not be previewed. Try opening it externally.
      </p>
    );
  return (
    <div className={container}>
      {preview.kind === "pdf" ? (
        // oxlint-disable-next-line react/iframe-missing-sandbox -- Chromium disables its PDF plugin in sandboxed iframes. The blob has a fixed application/pdf MIME type.
        <iframe title={`PDF preview: ${path}`} ref={attachSource} />
      ) : preview.kind === "image" ? (
        <img ref={attachSource} alt={path} onError={() => setFailed(true)} />
      ) : preview.kind === "audio" ? (
        <audio
          aria-label={path}
          ref={attachSource}
          controls
          onError={() => setFailed(true)}
        />
      ) : (
        <video
          aria-label={path}
          ref={attachSource}
          controls
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

const styles = {
  pdf: style({
    flex: "1 1 auto",
    minHeight: 0,
    display: "flex",
    "& iframe": { width: "100%", height: "100%", border: 0 },
  }),
  media: style(
    flex({ align: "center", justify: "center" }),
    spacing.padding({ all: 8 }),
    {
      flex: "1 1 auto",
      minHeight: 0,
      overflow: "auto",
      "& img, & video": {
        maxWidth: "100%",
        maxHeight: "100%",
        objectFit: "contain",
      },
      "& audio": { width: "min(100%, 600px)" },
    },
  ),
  status: style(
    text({ size: "sm", color: "lowContrast" }),
    spacing.padding({ all: 8 }),
  ),
};
