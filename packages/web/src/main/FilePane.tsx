import { useEffect } from "react";
import { reconnectStream } from "../api/reconnectStream.js";
import { useConnection } from "../api/ConnectionContext.js";
import { useQuery, useQueryClient, useIsMutating } from "@tanstack/react-query";
import { useApi } from "../api/ApiProvider.js";
import { MediaFilePreview } from "./MediaFilePreview.js";
import { TextFileEditor } from "./TextFileEditor.js";
import {
  backgroundColor,
  flex,
  proseContainerStyle,
  spacing,
  text,
} from "maui";
import { style, useStyles } from "purse-styles";
import { CodeViewFileEditor } from "./CodeViewFileEditor.tsx";
import { fileKind } from "./fileKind.ts";
import { MarkdownFileEditor } from "./editor/MarkdownFileEditor.js";

export function FilePane({ path }: { path: string }) {
  const api = useApi();
  const { service, state } = useConnection();
  const queryClient = useQueryClient();
  const connected = state.status === "connected";
  useEffect(() => {
    if (!connected || fileKind(path) !== "markdown") return;
    const controller = new AbortController();
    reconnectStream({
      name: "File updates",
      signal: controller.signal,
      open: async () =>
        await api.workspace.watchFile({ path }, { signal: controller.signal }),
      onItem: () => {
        void queryClient
          .invalidateQueries({
            queryKey: ["workspace-preview", path],
            exact: true,
          })
          .catch(console.error);
      },
      onError: (error) => service.fail(api, error),
    });
    return () => controller.abort();
  }, [api, connected, path, queryClient, service]);
  const changingEntry = useIsMutating({ mutationKey: ["workspace-entry"] });
  const preview = useQuery({
    queryKey: ["workspace-preview", path],
    enabled: state.status === "connected",
    queryFn: async () => await api.workspace.previewFile({ path }),
    gcTime: 0,
  });
  const pane = useStyles(styles.pane);
  const status = useStyles(styles.status);
  return (
    <main className={pane} aria-label={path} inert={changingEntry > 0}>
      {preview.isPending ? (
        <div className={status}>Loading file…</div>
      ) : preview.isError && preview.data === undefined ? (
        <div role="alert" className={status}>
          {preview.error.message}
        </div>
      ) : preview.data.kind === "text" ? (
        <TextFileContent path={path} loaded={preview.data.content} />
      ) : preview.data.kind === "unsupported" ? (
        <div className={status}>{preview.data.reason}</div>
      ) : (
        <MediaFilePreview key={path} preview={preview.data} path={path} />
      )}
    </main>
  );
}

function TextFileContent({ path, loaded }: { path: string; loaded: string }) {
  const kind = fileKind(path);
  const body = useStyles(kind === "code" ? styles.codeBody : styles.body);
  const content = useStyles(
    kind === "code" ? styles.codeContent : styles.content,
  );

  return (
    <div className={body}>
      <div className={content} data-testid="file-page-content">
        {kind === "markdown" ? (
          <MarkdownFileEditor key={path} path={path} loaded={loaded} />
        ) : kind === "code" ? (
          <CodeViewFileEditor key={path} path={path} loaded={loaded} />
        ) : (
          <TextFileEditor key={path} path={path} loaded={loaded} />
        )}
      </div>
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
  content: style(proseContainerStyle, {
    width: "100%",
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
