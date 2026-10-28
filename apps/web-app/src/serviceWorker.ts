/// <reference lib="webworker" />
import * as errore from "errore";

declare const self: ServiceWorkerGlobalScope;
declare const haloPrecacheAssets: string[];
declare const haloCacheVersion: string;

const cachePrefix = "halo-shell-";
const cacheName = `${cachePrefix}${haloCacheVersion}`;
const assets = new Set(haloPrecacheAssets);

class OfflineShellError extends errore.createTaggedError({
  name: "OfflineShellError",
  message: "Could not load Halo's offline shell.",
}) {}

self.addEventListener("install", (event) => {
  // A failed asset download rejects installation; never activate a partial shell.
  // Waiting updates activate only after existing windows close, preserving drafts.
  event.waitUntil(
    caches
      .open(cacheName)
      .then(
        async (cache) =>
          await cache.addAll(
            haloPrecacheAssets.map(
              (url) =>
                new Request(url, { credentials: "omit", cache: "reload" }),
            ),
          ),
      ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(async (names) => {
      await Promise.all(
        names
          .filter((name) => name.startsWith(cachePrefix) && name !== cacheName)
          .map(async (name) => await caches.delete(name)),
      );
      await self.clients.claim();
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // Never replace OAuth, API, workspace or standalone-extension documents.
  if (request.mode === "navigate" && ["/", "/login"].includes(url.pathname)) {
    event.respondWith(navigate(request));
    return;
  }
  // Only build assets are cache-first. In particular, /index.html navigations
  // and /manifest.json?extension=... must retain their server-owned identity.
  if (
    request.mode !== "navigate" &&
    url.search === "" &&
    assets.has(url.pathname)
  )
    event.respondWith(
      caches.open(cacheName).then(
        async (cache) =>
          // These public build assets are identical with or without Origin.
          (await cache.match(request, { ignoreVary: true })) ??
          (await fetch(request)),
      ),
    );
});

async function navigate(request: Request) {
  const response = await fetch(request, {
    signal: AbortSignal.timeout(5_000),
  }).catch((cause) => new OfflineShellError({ cause }));
  if (response instanceof Error) {
    console.warn(response);
    const cache = await caches.open(cacheName);
    return (await cache.match("/index.html")) ?? Response.error();
  }
  return response;
}
