import type { ChatReference } from "@get-halo/client";

const selectionEvent = "halo:capture-file-selection";
type FileSelectionDetail = { reference: ChatReference | undefined };

export function draftReferencesQueryKey(draftId: string) {
  return ["draft-references", draftId] as const;
}

export function captureFileSelection() {
  const detail: FileSelectionDetail = { reference: undefined };
  window.dispatchEvent(new CustomEvent(selectionEvent, { detail }));
  return detail.reference;
}

export function observeFileSelection(
  getReference: () => ChatReference | undefined,
) {
  const listener = (event: Event) => {
    // SAFETY: captureFileSelection is the sole dispatcher for this event.
    const detail = (event as CustomEvent<FileSelectionDetail>).detail;
    detail.reference = getReference();
  };
  window.addEventListener(selectionEvent, listener);
  return () => window.removeEventListener(selectionEvent, listener);
}
