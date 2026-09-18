import { useQuery, useIsMutating } from "@tanstack/react-query";
import { useApi } from "../api/ApiProvider.js";
import { MediaFilePreview } from "./MediaFilePreview.js";
import { TextFileEditor } from "./TextFileEditor.js";
import { backgroundColor, flex, proseMaxWidth, spacing, text } from "maui";
import { style, useStyles } from "purse-styles";
import { useWorkspaceFileQuery } from "../api/ApiProvider.tsx";
import { CodeViewFileEditor } from "./CodeViewFileEditor.tsx";
import { fileKind } from "./fileKind.ts";
import { MarkdownFileEditor } from "./MarkdownFileEditor.js";

export function FilePane({ path }: { path: string }) {
  const api = useApi();
  const changingEntry = useIsMutating({ mutationKey: ["workspace-entry"] });
  const preview = useQuery({
    queryKey: ["workspace-preview", path],
    queryFn: async () => await api.workspace.previewFile({ path }),
    gcTime: 0,
  });
  const pane = useStyles(styles.pane);
  const status = useStyles(styles.status);
  return (
    <main className={pane} aria-label={path} inert={changingEntry > 0}>
      {preview.isPending ? (
        <div className={status}>Loading file…</div>
      ) : preview.isError ? (
        <div role="alert" className={status}>
          {preview.error.message}
        </div>
      ) : preview.data.kind === "text" ? (
        <TextFileContent path={path} />
      ) : preview.data.kind === "unsupported" ? (
        <div className={status}>{preview.data.reason}</div>
      ) : (
        <MediaFilePreview key={path} preview={preview.data} path={path} />
      )}
    </main>
  );
}

function TextFileContent({ path }: { path: string }) {
  const file = useWorkspaceFileQuery(path);
  const kind = fileKind(path);
  const body = useStyles(kind === "code" ? styles.codeBody : styles.body);
  const content = useStyles(
    kind === "code" ? styles.codeContent : styles.content,
  );
  const status = useStyles(styles.status);

  return (
    <div className={body}>
      {file.isPending ? (
        <div className={status}>Loading file…</div>
      ) : file.isError ? (
        <div className={status} role="alert">
          {String(file.error)}
        </div>
      ) : (
        <div className={content} data-testid="file-page-content">
          {kind === "markdown" ? (
            <MarkdownFileEditor key={path} path={path} loaded={file.data} />
          ) : kind === "code" ? (
            <CodeViewFileEditor key={path} path={path} loaded={file.data} />
          ) : (
            <TextFileEditor key={path} path={path} loaded={file.data} />
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  pane: style(flex({ direction: "column" }), {
    width: "100%",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    backgroundColor: backgroundColor.app,
  }),
  body: style(spacing.padding({ all: 12 }), {
    flex: "1 1 auto",
    minWidth: 0,
    minHeight: 0,
    overflow: "auto",
    overscrollBehavior: "contain",
  }),
  codeBody: style({
    flex: "1 1 auto",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    display: "flex",
  }),
  content: style({
    width: "100%",
    maxWidth: proseMaxWidth,
    marginInline: "auto",
    minWidth: 0,
    height: "100%",
  }),
  codeContent: style({
    width: "100%",
    flex: "1 1 auto",
    minWidth: 0,
    minHeight: 0,
    display: "flex",
  }),
  status: style(text({ size: "sm", color: "lowContrast" })),
};
