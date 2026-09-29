import { useMemo, useRef, useState } from "react";
import {
  Editor,
  type EditorOptions,
  type EditorType,
} from "@pierre/diffs/edit";
import {
  CodeView,
  EditProvider,
  type CodeViewHandle,
  type CodeViewItem,
} from "@pierre/diffs/react";
import { monoFontFamily, useTheme } from "maui";
import { style, useStyles } from "purse-styles";
import { useAutosaveFile } from "./useAutosaveFile.ts";
import { useTabFindSource } from "../panes/TabFind.js";

const diffsTheme = {
  dark: "pierre-dark",
  light: "pierre-light",
} as const;

const pierreUnsafeCss = `:host { --diffs-font-family: ${monoFontFamily}; }`;

function createPierreEditor<EType extends EditorType>(
  editorType: EType,
  options: EditorOptions<EType, undefined, undefined>,
) {
  return new Editor(editorType, options);
}

export function CodeViewFileEditor({
  path,
  loaded,
}: {
  path: string;
  loaded: string;
}) {
  const { resolvedTheme } = useTheme();
  const autosave = useAutosaveFile({ path, loaded });
  const [initial] = useState(loaded);
  const [content, setContent] = useState(loaded);
  const codeView = useRef<CodeViewHandle<undefined, undefined>>(null);
  const findSource = useMemo(
    () => ({
      segments: [{ id: path, text: content }],
      select: (_segmentId: string, start: number, end: number) => {
        const before = content.slice(0, start).split("\n");
        const endBefore = content.slice(0, end).split("\n");
        const editor = codeView.current?.getEditor(path);
        codeView.current?.setSelectedLines({
          id: path,
          range: { start: before.length, end: endBefore.length },
        });
        if (editor?.getEditState() !== undefined) {
          const view = editor.getViewState().view;
          if (view !== undefined)
            editor.setViewState({
              selections: [
                {
                  start: {
                    line: before.length - 1,
                    character: before.at(-1)?.length ?? 0,
                  },
                  end: {
                    line: endBefore.length - 1,
                    character: endBefore.at(-1)?.length ?? 0,
                  },
                  direction: 1,
                },
              ],
              view,
            });
        }
        codeView.current?.scrollTo({
          type: "line",
          id: path,
          lineNumber: before.length,
          align: "center",
        });
      },
    }),
    [path, content],
  );
  useTabFindSource(findSource);
  const host = useStyles(hostClass);
  const view = useStyles(viewClass);

  const items = useMemo(
    (): CodeViewItem<undefined>[] => [
      {
        type: "file",
        id: path,
        version: 1,
        edit: true,
        file: {
          name: path,
          contents: initial,
          cacheKey: path,
        },
      },
    ],
    [path, initial],
  );

  const options = useMemo(
    () => ({
      theme: diffsTheme,
      themeType: resolvedTheme,
      overflow: "scroll" as const,
      disableFileHeader: true,
      unsafeCSS: pierreUnsafeCss,
    }),
    [resolvedTheme],
  );

  return (
    <div className={host}>
      <EditProvider createEditor={createPierreEditor}>
        <CodeView
          ref={codeView}
          items={items}
          options={options}
          disableWorkerPool
          onItemEditChange={(event) => {
            setContent(event.file.contents);
            autosave.onChange(event.file.contents);
          }}
          className={view}
        />
      </EditProvider>
    </div>
  );
}

const hostClass = style({
  flex: "1 1 auto",
  minWidth: 0,
  minHeight: 0,
  height: "100%",
});

// CodeView virtualizes against its root element, so the root must be the scroll container.
const viewClass = style({
  width: "100%",
  height: "100%",
  overflow: "auto",
  overscrollBehavior: "contain",
});
