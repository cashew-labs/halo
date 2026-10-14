import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthService } from "../auth/AuthService.js";
import type { AppStore } from "./AppStore.js";
import { isAppRequestError, type AppService } from "./AppService.js";
import { creatorOrigin } from "./creatorHost.js";

const listingPattern = /^\/templates\/([a-z][a-z0-9-]{0,62})$/;
const actionPattern =
  /^\/api\/templates\/([a-z][a-z0-9-]{0,62})\/(install|signin)$/;

export function isTemplateRequest(url: URL) {
  return listingPattern.test(url.pathname) || actionPattern.test(url.pathname);
}

/**
 * The trusted template listing on Halo's origin. Halo renders its chrome and
 * the escaped name and description; the template's own code runs only in the
 * demo frame on the creator host.
 */
export async function serveTemplate(ctx: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  auth: AuthService;
  store: AppStore;
  apps: AppService;
  publicOrigin: string;
}) {
  const { request, response, url } = ctx;
  const listing = listingPattern.exec(url.pathname);
  const action = actionPattern.exec(url.pathname);
  const slug = (listing ?? action)![1]!;
  const template = await ctx.store.findTemplate(slug);
  // coverage-exempt: App database outage; no service mocks in the real control-plane fixture.
  if (template instanceof Error) {
    console.error(template);
    respond(response, 500);
    return;
  }
  if (template === undefined || !template.ready) {
    respond(response, 404);
    return;
  }
  const listingUrl = new URL(`/templates/${slug}`, ctx.publicOrigin).toString();
  const demo = `${creatorOrigin({ publicOrigin: ctx.publicOrigin, handle: template.handle })}/demo-${slug}/view/`;
  if (listing !== null) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      respond(response, 405);
      return;
    }
    const session = await ctx.auth.getSession(cookieHeaders(request));
    // coverage-exempt: Auth database outage; no service mocks in the real control-plane fixture.
    if (session instanceof Error) {
      console.error(session);
      respond(response, 500);
      return;
    }
    page({
      response,
      demoOrigin: new URL(demo).origin,
      body: `<header><p class="crumb">Halo template · by ${escape(template.handle)}</p><h1>${escape(template.displayName)}</h1><p>${escape(template.description)}</p>
<form method="post" action="/api/templates/${slug}/${session === undefined ? "signin" : "install"}"><button type="submit">${session === undefined ? "Sign in to install" : "Install a copy"}</button></form>
<p class="note">Installing creates your own private copy with sample data on its own server. It does not include the author's data or connections.</p></header>
<iframe title="${escape(template.displayName)} demo" src="${escape(demo)}" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer"></iframe>
<p class="note">The demo shows sample data and simulated results. Your changes in it are private and reset.</p>`,
    });
    return;
  }
  if (request.method !== "POST") {
    respond(response, 405);
    return;
  }
  // Forms on the listing page are the only allowed source of these requests.
  if (request.headers.origin !== ctx.publicOrigin) {
    respond(response, 403);
    return;
  }
  if (action![2] === "signin") {
    const started = await ctx.auth.startAppSignIn(listingUrl);
    // coverage-exempt: Better Auth failed to start Google sign-in; the success path is tested.
    if (started instanceof Error) {
      console.error(started);
      respond(response, 500);
      return;
    }
    response
      .writeHead(303, {
        location: started.authorizationUrl,
        "set-cookie": started.headers.getSetCookie(),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      })
      .end();
    return;
  }
  const session = await ctx.auth.getSession(cookieHeaders(request));
  // coverage-exempt: Auth database outage; no service mocks in the real control-plane fixture.
  if (session instanceof Error) {
    console.error(session);
    respond(response, 500);
    return;
  }
  if (session === undefined) {
    respond(response, 401);
    return;
  }
  const installed = await ctx.apps.installTemplate({
    ownerUserId: session.user.id,
    ownerEmail: session.user.email,
    slug,
  });
  if (installed instanceof Error && !isAppRequestError(installed))
    console.error(installed);
  page({
    response,
    status: installed instanceof Error ? 400 : 200,
    demoOrigin: new URL(demo).origin,
    body:
      installed instanceof Error
        ? `<h1>Could not install ${escape(template.displayName)}</h1><p>${escape(isAppRequestError(installed) ? installed.message : "Installation was interrupted.")}</p><form method="post" action="/api/templates/${slug}/install"><button type="submit">Try again</button></form>`
        : `<h1>Installed ${escape(installed.displayName)}</h1><p>Your private copy is in Halo's sidebar. It starts with sample data and no connections; ask Halo to connect your own tools before you share it.</p><p><a href="/">Open Halo</a></p>`,
  });
}

function cookieHeaders(request: IncomingMessage) {
  const headers = new Headers();
  if (request.headers.cookie !== undefined)
    headers.set("cookie", request.headers.cookie);
  return headers;
}

function page(ctx: {
  response: ServerResponse;
  status?: number;
  demoOrigin: string;
  body: string;
}) {
  ctx.response
    .writeHead(ctx.status ?? 200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; frame-src ${ctx.demoOrigin}; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'`,
    })
    .end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Halo template</title><style>
:root{color-scheme:light dark;--bg:#f6f6f4;--fg:#1d1d1b;--muted:#5b5b57;--button:#1d1d1b;--button-fg:#fff;--line:#deded9}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#f1f1ee;--muted:#a9a9a4;--button:#f1f1ee;--button-fg:#161615;--line:#33332f}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:1080px;margin:0 auto;padding:24px 16px;display:grid;gap:16px}
h1{font-size:28px;line-height:1.2;margin:0 0 8px}.crumb,.note{color:var(--muted);font-size:14px;margin:0}
button{font:inherit;padding:10px 16px;border-radius:8px;border:0;background:var(--button);color:var(--button-fg);cursor:pointer;margin:8px 0}
iframe{width:100%;height:min(70vh,720px);border:1px solid var(--line);border-radius:12px;background:#fff}
a{color:inherit}</style></head><body><main>${ctx.body}</main></body></html>`,
    );
}

function escape(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

function respond(response: ServerResponse, status: number) {
  response.writeHead(status, { "cache-control": "no-store" }).end();
}
