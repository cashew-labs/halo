import type { IncomingMessage, ServerResponse } from "node:http";
import getRawBody from "raw-body";
import * as errore from "errore";
import type { AuthService } from "../auth/AuthService.js";
import type { AppStore } from "./AppStore.js";
import { appReturnPath, creatorOrigin } from "./creatorHost.js";

class AppHandoffError extends errore.createTaggedError({
  name: "AppHandoffError",
  message: "App sign-in failed: $detail",
}) {}

const handlePattern = /^[a-z][a-z0-9-]{0,40}$/;
// The creator host's random sign-in state, carried through Google sign-in.
const statePattern = /^[A-Za-z0-9_-]{43}$/;

export function isAppHandoffRequest(url: URL) {
  return (
    url.pathname === "/api/apps/handoff" || url.pathname === "/api/apps/signin"
  );
}

/**
 * Halo's own origin vouches for a signed-in person to one creator host. The
 * person confirms with a same-origin form; the creator host then receives a
 * single-use code, never Halo's session cookie.
 */
export async function serveAppHandoff(ctx: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  auth: AuthService;
  store: AppStore;
  publicOrigin: string;
}) {
  const { request, response, url } = ctx;
  const input =
    request.method === "POST"
      ? await readForm(request)
      : request.method === "GET"
        ? url.searchParams
        : undefined;
  if (input instanceof Error || input === undefined) {
    respond(response, input === undefined ? 405 : 400);
    return;
  }
  const handle = input.get("host") ?? "";
  const returnPath = input.get("return") ?? "/";
  const state = input.get("state") ?? "";
  if (
    !handlePattern.test(handle) ||
    // The same paths the creator host accepts, or its root.
    (returnPath !== "/" && appReturnPath(returnPath) === undefined) ||
    !statePattern.test(state)
  ) {
    respond(response, 400);
    return;
  }
  const known = await ctx.store.hasHandle(handle);
  // coverage-exempt: App database outage; no service mocks in the real control-plane fixture.
  if (known instanceof Error) {
    console.error(known);
    respond(response, 500);
    return;
  }
  if (!known) {
    respond(response, 404);
    return;
  }
  // State changes need a form submitted from Halo's own pages.
  if (
    request.method === "POST" &&
    request.headers.origin !== ctx.publicOrigin
  ) {
    respond(response, 403);
    return;
  }
  const target = creatorOrigin({ publicOrigin: ctx.publicOrigin, handle });
  const headers = new Headers();
  if (request.headers.cookie !== undefined)
    headers.set("cookie", request.headers.cookie);
  const session = await ctx.auth.getSession(headers);
  // coverage-exempt: Auth database outage; no service mocks in the real control-plane fixture.
  if (session instanceof Error) {
    console.error(session);
    respond(response, 500);
    return;
  }
  const handoff = new URL("/api/apps/handoff", ctx.publicOrigin);
  handoff.searchParams.set("host", handle);
  handoff.searchParams.set("return", returnPath);
  handoff.searchParams.set("state", state);
  if (url.pathname === "/api/apps/signin") {
    if (request.method !== "POST") {
      respond(response, 405);
      return;
    }
    const started = await ctx.auth.startAppSignIn(handoff.toString());
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
  if (request.method === "GET") {
    page({
      response,
      target,
      title:
        session === undefined
          ? `Sign in to open an app on ${new URL(target).host}`
          : `Open ${new URL(target).host} as ${session.user.email}?`,
      detail:
        session === undefined
          ? "This app is shared with specific Halo accounts."
          : "The app will see your email address if you were invited.",
      action: session === undefined ? "/api/apps/signin" : "/api/apps/handoff",
      button: session === undefined ? "Sign in with Google" : "Continue",
      fields: { host: handle, return: returnPath, state },
    });
    return;
  }
  if (session === undefined) {
    respond(response, 401);
    return;
  }
  const code = await ctx.store.createHandoff({
    handle,
    state,
    userId: session.user.id,
    email: session.user.email.toLowerCase(),
  });
  // coverage-exempt: App database outage; no service mocks in the real control-plane fixture.
  if (code instanceof Error) {
    console.error(code);
    respond(response, 500);
    return;
  }
  const redeem = new URL("/__halo/handoff", target);
  redeem.searchParams.set("code", code);
  redeem.searchParams.set("return", returnPath);
  respond(response, 303, {
    location: redeem.toString(),
    "referrer-policy": "no-referrer",
  });
}

async function readForm(request: IncomingMessage) {
  if (
    request.headers["content-type"]?.split(";")[0]?.trim() !==
    "application/x-www-form-urlencoded"
  )
    return new AppHandoffError({ detail: "unsupported form" });
  const body = await getRawBody(request, {
    length: request.headers["content-length"],
    limit: 4096,
    encoding: "utf8",
  }).catch((cause: unknown) => {
    request.resume();
    return new AppHandoffError({ detail: "read form", cause });
  });
  if (body instanceof Error) return body;
  return new URLSearchParams(body);
}

function page(ctx: {
  response: ServerResponse;
  target: string;
  title: string;
  detail: string;
  action: string;
  button: string;
  fields: Record<string, string>;
}) {
  const inputs = Object.entries(ctx.fields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`,
    )
    .join("");
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Halo</title><style>body{font:16px system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f6f4;color:#1d1d1b}main{max-width:360px;padding:24px}h1{font-size:20px;line-height:1.3}p{color:#5b5b57}button{font:inherit;padding:10px 16px;border-radius:8px;border:0;background:#1d1d1b;color:#fff;cursor:pointer}@media (prefers-color-scheme:dark){body{background:#161615;color:#f1f1ee}p{color:#a9a9a4}button{background:#f1f1ee;color:#161615}}</style></head><body><main><h1>${escape(ctx.title)}</h1><p>${escape(ctx.detail)}</p><form method="post" action="${escape(ctx.action)}">${inputs}<button type="submit">${escape(ctx.button)}</button></form></main></body></html>`;
  ctx.response
    .writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com ${ctx.target}; frame-ancestors 'none'; base-uri 'none'`,
    })
    .end(body);
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

function respond(
  response: ServerResponse,
  status: number,
  headers: Record<string, string> = {},
) {
  response.writeHead(status, { "cache-control": "no-store", ...headers }).end();
}
