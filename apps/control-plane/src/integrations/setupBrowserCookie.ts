// Each browser that Halo opens for a setup keeps a secret in a cookie named for
// that setup, so several setups can run in one browser.
const cookiePrefix = "halo_setup_";
const cookieMaxAgeSeconds = 15 * 60;

export function setupBrowserCookie(input: {
  setupId: string;
  browser: string;
  publicOrigin: string;
}) {
  // Lax lets the provider's top-level redirect to the callback carry it.
  const attributes = [
    `${cookiePrefix}${input.setupId}=${input.browser}`,
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
export function setupBrowserCookies(headers: Headers) {
  const browsers = new Map<string, string>();
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (!name.startsWith(cookiePrefix)) continue;
    browsers.set(
      name.slice(cookiePrefix.length),
      part.slice(separator + 1).trim(),
    );
  }
  return browsers;
}
