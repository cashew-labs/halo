// Each browser that Halo opens for a setup keeps a secret in a cookie named for
// that setup, so several setups can run in one browser. On HTTPS the
// `__Host-` prefix keeps creator subdomains from planting one on Halo's origin.
const cookieMaxAgeSeconds = 15 * 60;

function cookiePrefix(publicOrigin: string) {
  return new URL(publicOrigin).protocol === "https:"
    ? "__Host-halo_setup_"
    : "halo_setup_";
}

export function setupBrowserCookie(input: {
  setupId: string;
  browser: string;
  publicOrigin: string;
}) {
  // Lax lets the provider's top-level redirect to the callback carry it.
  const attributes = [
    `${cookiePrefix(input.publicOrigin)}${input.setupId}=${input.browser}`,
    "Path=/",
    `Max-Age=${cookieMaxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (new URL(input.publicOrigin).protocol === "https:")
    attributes.push("Secure");
  return attributes.join("; ");
}

// Maps setup IDs to the browser secrets in a Cookie header.
export function setupBrowserCookies(headers: Headers, publicOrigin: string) {
  const prefix = cookiePrefix(publicOrigin);
  const browsers = new Map<string, string>();
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (!name.startsWith(prefix)) continue;
    browsers.set(name.slice(prefix.length), part.slice(separator + 1).trim());
  }
  return browsers;
}
