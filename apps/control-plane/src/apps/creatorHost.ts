const handlePattern = /^[a-z][a-z0-9-]{0,40}$/;

/**
 * Creator hosts are one browser origin per creator: `handle.<Halo host>`, with
 * one path per app. Local development uses `handle.localhost:<port>`.
 */
export function creatorOrigin(ctx: { publicOrigin: string; handle: string }) {
  const url = new URL(ctx.publicOrigin);
  url.hostname = `${ctx.handle}.${baseHostname(url.hostname)}`;
  return url.origin;
}

/** The creator handle a Host header names, or undefined for every other host. */
export function creatorHandle(ctx: {
  publicOrigin: string;
  host: string | undefined;
}) {
  if (ctx.host === undefined) return undefined;
  const url = new URL(ctx.publicOrigin);
  const port = url.port === "" ? "" : `:${url.port}`;
  const suffix = `.${baseHostname(url.hostname)}${port}`;
  const host = ctx.host.toLowerCase();
  if (!host.endsWith(suffix)) return undefined;
  const handle = host.slice(0, -suffix.length);
  return handlePattern.test(handle) ? handle : undefined;
}

function baseHostname(hostname: string) {
  return hostname === "localhost" || /^[0-9.]+$/.test(hostname)
    ? "localhost"
    : hostname;
}
