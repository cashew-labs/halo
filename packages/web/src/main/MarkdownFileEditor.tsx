import { HybridMarkdownEditor } from "./HybridMarkdownEditor.js";
import { useState } from "react";
import { useAutosaveFile } from "./useAutosaveFile.js";
import { useApi } from "../api/ApiProvider.js";

export function MarkdownFileEditor({
  path,
  loaded,
}: {
  path: string;
  loaded: string;
}) {
  const autosave = useAutosaveFile({ path, loaded });
  const api = useApi();
  const [error, setError] = useState<string>();
  return (
    <>
      {error !== undefined && <p role="alert">{error}</p>}
      <HybridMarkdownEditor
        content={loaded}
        onChange={autosave.onChange}
        aria-label={path}
        size="sm"
        resources={{ api, documentPath: path, onError: setError }}
      />
    </>
  );
}
