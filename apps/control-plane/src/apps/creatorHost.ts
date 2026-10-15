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

// Only URL-safe ASCII: the decoded value becomes a Location header.
const returnPathPattern =
  /^\/[a-z][a-z0-9-]{0,62}\/(?:view(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?)?$/;

/** An app path on a creator host that sign-in may return to, or undefined. */
export function appReturnPath(value: string | null) {
  return value !== null && returnPathPattern.test(value) ? value : undefined;
}
