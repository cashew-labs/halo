export const imageMediaTypes = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["ico", "image/x-icon"],
]);

/** A client-selected ID makes image insertion synchronous and undoable during upload. */
export function imageFilename(input: { id: string; mime: string }) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      input.id,
    )
  )
    return undefined;
  const extension = [...imageMediaTypes].find(
    ([, mime]) => mime === input.mime,
  )?.[0];
  return extension === undefined ? undefined : `image-${input.id}.${extension}`;
}
