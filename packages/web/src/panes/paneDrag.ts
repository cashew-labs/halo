export const paneTabDragType = "application/x-halo-tab";
export const paneRouteDragType = "application/x-halo-route";

export function isPaneDrag(data: DataTransfer) {
  return (
    data.types.includes(paneTabDragType) ||
    data.types.includes(paneRouteDragType)
  );
}
