import { useMemo, useState } from "react";
import {
  Editor,
  type EditorOptions,
  type EditorType,
} from "@pierre/diffs/edit";
import { CodeView, EditProvider, type CodeViewItem } from "@pierre/diffs/react";
import { monoFontFamily, useTheme } from "maui";
import { style, useStyles } from "purse-styles";
import { useAutosaveFile } from "./useAutosaveFile.ts";

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
          items={items}
          options={options}
          disableWorkerPool
          onItemEditChange={(event) => {
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
