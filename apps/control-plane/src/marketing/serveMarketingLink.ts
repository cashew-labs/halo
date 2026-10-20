import type { MarketingLinks } from "./MarketingLinks.js";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Resolve only enabled saved slugs to Halo's homepage; no visitor-supplied target. */
export async function serveMarketingLink(ctx: {
  request: IncomingMessage;
  response: ServerResponse;
  homepageOrigin: string;
  links: Pick<MarketingLinks, "resolve">;
}) {
  const { request, response, homepageOrigin, links } = ctx;
  response.setHeader("cache-control", "no-store");
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  // Match the raw request target: dot segments, encoded separators and absolute
  // URLs must not be normalized into a configured campaign.
  const match = /^\/([a-z0-9][a-z0-9-]{0,62})\/?(?:\?[^#]*)?$/.exec(
    request.url ?? "/",
  );
  const slug = match?.[1];
  const tags = slug === undefined ? undefined : await links.resolve(slug);
  if (tags instanceof Error) {
    console.error(tags);
    response.writeHead(500).end();
    return;
  }
  if (tags === undefined) {
    response.writeHead(404).end();
    return;
  }
  const destination = new URL("/", homepageOrigin);
  for (const [key, value] of Object.entries(tags))
    if (value !== undefined) destination.searchParams.set(key, value);
  response.writeHead(302, { location: destination.href }).end();
}
