/**
 * Creator hosts are one browser origin per creator: `handle.<Halo host>`, with
 * one path per app. Local development uses `handle.localhost:<port>`.
 */
export function creatorOrigin(ctx: { publicOrigin: string; handle: string }) {
  const url = new URL(ctx.publicOrigin);
  url.hostname = `${ctx.handle}.${baseHostname(url.hostname)}`;
  return url.origin;
}

function baseHostname(hostname: string) {
  return hostname === "localhost" || /^[0-9.]+$/.test(hostname)
    ? "localhost"
    : hostname;
}
