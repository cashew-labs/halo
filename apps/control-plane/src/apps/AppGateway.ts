import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createProxyServer } from "httpxy";
import * as errore from "errore";
import type { WorkspaceProviderApi } from "../workspace/provider/WorkspaceProviderApi.js";
import type { WorkspaceAuthorization } from "../workspace/proxy.js";
import type { AppRecord, AppStore } from "./AppStore.js";
import { appReturnPath, creatorOrigin } from "./creatorHost.js";

class AppGatewayError extends errore.createTaggedError({
  name: "AppGatewayError",
  message: "App gateway failed: $detail",
}) {}

// Only the SDK's view, API and sync routes reach an app.
const appPathPattern =
  /^\/([a-z][a-z0-9-]{0,62})(?:\/(view|api|sync)(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?)?\/?$/;
// Rejects encoded separators and dot segments before any routing decision.
const unsafePathPattern = /%(?:2f|5c|2e|00)|\\|\/\/|(?:^|\/)\.{1,2}(?:\/|$)/i;
const visitorPattern = /^[A-Za-z0-9_-]{22}$/;

const appProxy = createProxyServer();
appProxy.on("proxyRes", (upstream) => {
  // Apps on one creator host must not plant cookies for Halo or each other.
  delete upstream.headers["set-cookie"];
  upstream.headers["x-content-type-options"] = "nosniff";
  upstream.headers["referrer-policy"] = "same-origin";
  // Responses are rendered for one viewer; shared caches must not reuse them.
  upstream.headers["cache-control"] = "private, no-store";
});

type CookieName = "session" | "visitor" | "handoff";

type Viewer = {
  viewerId: string;
  role: "owner" | "member" | "public";
  email?: string;
};

/**
 * Serves `handle.<Halo host>/<slug>/…` from each app's own VM. It runs in the
 * control-plane process but never reaches Halo's cookies, RPC or workspaces.
 * All apps of one creator share this origin; access is checked per app.
 */
export class AppGateway {
  private readonly store: AppStore;
  private readonly provider: WorkspaceProviderApi;
  private readonly authorization: WorkspaceAuthorization;
  private readonly publicOrigin: URL;

  constructor(ctx: {
    store: AppStore;
    provider: WorkspaceProviderApi;
    authorization: WorkspaceAuthorization;
    publicOrigin: string;
  }) {
    this.store = ctx.store;
    this.provider = ctx.provider;
    this.authorization = ctx.authorization;
    this.publicOrigin = new URL(ctx.publicOrigin);
  }

  async serve(ctx: {
    request: IncomingMessage;
    response: ServerResponse;
    handle: string;
  }) {
    const { request, response, handle } = ctx;
    const raw = request.url ?? "/";
    // Check the raw target: URL parsing would turn "\" into "/" and drop dots.
    const rawPath = raw.split("?")[0]!;
    const url = new URL(raw, "http://creator.invalid");
    if (
      !raw.startsWith("/") ||
      unsafePathPattern.test(rawPath) ||
      url.pathname !== rawPath
    ) {
      respond(response, 404);
      return;
    }
    if (url.pathname === "/__halo/signin") {
      // Only this browser holds the state, so a code another browser obtained
      // cannot sign it in (login CSRF).
      const state = crypto.randomBytes(32).toString("base64url");
      const target = new URL("/api/apps/handoff", this.publicOrigin);
      target.searchParams.set("host", handle);
      target.searchParams.set(
        "return",
        safeReturnPath(url.searchParams.get("return")),
      );
      target.searchParams.set("state", state);
      respond(response, 302, {
        location: target.toString(),
        "set-cookie": this.setCookie("handoff", state, 10 * 60),
        "referrer-policy": "no-referrer",
      });
      return;
    }
    if (url.pathname === "/__halo/handoff") {
      await this.redeem({ request, response, handle, url });
      return;
    }
    if (url.pathname === "/__halo/signout") {
      const token = this.cookie(request, "session");
      if (token !== undefined) {
        const deleted = await this.store.deleteViewerSession(token);
        if (deleted instanceof Error) console.error(deleted);
      }
      // Creator hosts serve only app paths, so return to the visitor's app.
      const location = safeReturnPath(url.searchParams.get("return"));
      if (location === "/") {
        respond(
          response,
          200,
          {
            "content-type": "text/plain; charset=utf-8",
            "set-cookie": this.clearCookie("session"),
          },
          "Signed out.",
        );
        return;
      }
      respond(response, 302, {
        location,
        "set-cookie": this.clearCookie("session"),
      });
      return;
    }
    const route = appPathPattern.exec(url.pathname);
    if (route === null) {
      respond(response, 404);
      return;
    }
    const [, slug, kind, rest] = route;
    const app = await this.store.findByAddress({ handle, slug: slug! });
    // coverage-exempt: App database outage; no service mocks in the real control-plane fixture.
    if (app instanceof Error) {
      console.error(app);
      respond(response, 500);
      return;
    }
    if (app === undefined || app.stage !== "live") {
      respond(response, 404);
      return;
    }
    // The SDK view locates its API and sync routes from the /view/ path.
    if (kind === undefined) {
      respond(response, 302, { location: `/${slug}/view/` });
      return;
    }
    const viewer = await this.viewer({ request, response, app, handle });
    // coverage-exempt: App database outage; no service mocks in the real control-plane fixture.
    if (viewer instanceof Error) {
      console.error(viewer);
      respond(response, 500);
      return;
    }
    if (viewer === "hidden") {
      respond(response, 404);
      return;
    }
    if (viewer === "sign-in") {
      if (kind === "view" && request.method === "GET")
        respond(response, 302, {
          location: `/__halo/signin?return=${encodeURIComponent(url.pathname)}`,
        });
      else respond(response, 401);
      return;
    }
    if (viewer === "forbidden") {
      respond(response, 403);
      return;
    }
    // Visitor cookies ride along on cross-site requests; writes need this origin.
    const origin = creatorOrigin({
      publicOrigin: this.publicOrigin.origin,
      handle,
    });
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.headers.origin !== origin
    ) {
      respond(response, 403);
      return;
    }
    await this.forward({
      request,
      response,
      app,
      viewer,
      origin,
      path: `/extensions/${app.extensionId}/${kind}${rest ?? (kind === "view" ? "/" : "")}${url.search}`,
    });
  }

  private async viewer(ctx: {
    request: IncomingMessage;
    response: ServerResponse;
    app: AppRecord;
    handle: string;
  }): Promise<Viewer | "hidden" | "sign-in" | "forbidden" | Error> {
    const token = this.cookie(ctx.request, "session");
    const session =
      token === undefined
        ? undefined
        : await this.store.findViewerSession({ handle: ctx.handle, token });
    if (session instanceof Error) return session;
    if (session?.userId === ctx.app.ownerUserId)
      return { viewerId: session.userId, role: "owner", email: session.email };
    if (!ctx.app.published) return "hidden";
    if (session !== undefined && ctx.app.members.includes(session.email))
      return { viewerId: session.userId, role: "member", email: session.email };
    if (ctx.app.visibility === "invited")
      return session === undefined ? "sign-in" : "forbidden";
    // Public visitors are pseudonymous, even when signed in to Halo.
    const existing = this.cookie(ctx.request, "visitor");
    if (existing !== undefined && visitorPattern.test(existing))
      return { viewerId: `visitor-${existing}`, role: "public" };
    const visitor = crypto.randomBytes(16).toString("base64url");
    ctx.response.setHeader(
      "set-cookie",
      this.setCookie("visitor", visitor, 365 * 24 * 60 * 60),
    );
    return { viewerId: `visitor-${visitor}`, role: "public" };
  }

  private async redeem(ctx: {
    request: IncomingMessage;
    response: ServerResponse;
    handle: string;
    url: URL;
  }) {
    const code = ctx.url.searchParams.get("code");
    const state = this.cookie(ctx.request, "handoff");
    const token =
      code === null || code.length > 128 || state === undefined
        ? undefined
        : await this.store.redeemHandoff({ handle: ctx.handle, code, state });
    // coverage-exempt: App database outage; no service mocks in the real control-plane fixture.
    if (token instanceof Error) {
      console.error(token);
      respond(ctx.response, 500);
      return;
    }
    if (token === undefined) {
      respond(ctx.response, 400);
      return;
    }
    const cookies = [
      this.setCookie("session", token, 7 * 24 * 60 * 60),
      this.clearCookie("handoff"),
    ];
    const location = appReturnPath(ctx.url.searchParams.get("return"));
    // Creator hosts serve only app paths; without one, confirm on the page.
    if (location === undefined) {
      respond(
        ctx.response,
        200,
        {
          "content-type": "text/plain; charset=utf-8",
          "set-cookie": cookies,
          "referrer-policy": "no-referrer",
        },
        "Signed in.",
      );
      return;
    }
    respond(ctx.response, 302, {
      location,
      "set-cookie": cookies,
      "referrer-policy": "no-referrer",
    });
  }

  private async forward(ctx: {
    request: IncomingMessage;
    response: ServerResponse;
    app: AppRecord;
    viewer: Viewer;
    origin: string;
    path: string;
  }) {
    const connection = await this.provider.getConnection({
      workspaceId: ctx.app.appId,
      ownerUserId: ctx.app.ownerUserId,
    });
    if (connection instanceof Error) console.error(connection);
    if (connection === undefined || connection instanceof Error) {
      respond(ctx.response, 503);
      return;
    }
    const authorization = await this.authorization.headers(connection);
    // coverage-exempt: Only Google identity tokens fail here; tests use gateway bearer tokens.
    if (authorization instanceof Error) {
      console.error(authorization);
      respond(ctx.response, 502);
      return;
    }

    const target = new URL(connection.origin);
    const headers = ctx.request.headers;
    // Only a fixed allowlist of browser headers reaches the app VM.
    const forwarded: Record<string, string> = {};
    for (const name of [
      "accept",
      "accept-language",
      "content-type",
      "content-length",
      "if-none-match",
      "last-event-id",
      "transfer-encoding",
    ]) {
      const value = headers[name];
      if (value !== undefined && !Array.isArray(value)) forwarded[name] = value;
    }
    for (const [name, value] of Object.entries(authorization))
      forwarded[name.toLowerCase()] = value;
    forwarded.host = target.host;
    forwarded["x-halo-public-host"] = new URL(ctx.origin).host;
    forwarded["x-halo-public-proto"] = this.publicOrigin.protocol.slice(0, -1);
    forwarded["x-halo-viewer-id"] = ctx.viewer.viewerId;
    forwarded["x-halo-viewer-role"] = ctx.viewer.role;
    if (ctx.viewer.email !== undefined)
      forwarded["x-halo-viewer-email"] = ctx.viewer.email;
    ctx.request.headers = forwarded;
    ctx.request.url = ctx.path;
    const proxied = await appProxy
      .web(ctx.request, ctx.response, { target: target.origin, xfwd: false })
      .catch(
        (cause) => new AppGatewayError({ detail: "proxy request", cause }),
      );
    if (!(proxied instanceof Error)) return;
    console.error(proxied);
    // httpxy rejects only before the app VM answers. A failure mid-response
    // aborts the visitor's response inside httpxy instead.
    if (!ctx.response.headersSent) respond(ctx.response, 502);
  }

  private cookieName(name: CookieName) {
    // __Host- requires HTTPS; local development serves plain HTTP.
    return this.publicOrigin.protocol === "https:"
      ? `__Host-halo-${name}`
      : `halo-${name}`;
  }

  private cookie(request: IncomingMessage, name: CookieName) {
    const wanted = this.cookieName(name);
    for (const part of (request.headers.cookie ?? "").split(";")) {
      const separator = part.indexOf("=");
      if (separator === -1) continue;
      if (part.slice(0, separator).trim() === wanted)
        return part.slice(separator + 1).trim();
    }
    return undefined;
  }

  private setCookie(name: CookieName, value: string, maxAge: number) {
    const secure = this.publicOrigin.protocol === "https:" ? "; Secure" : "";
    return `${this.cookieName(name)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  }

  private clearCookie(name: CookieName) {
    return this.setCookie(name, "", 0);
  }
}

function safeReturnPath(value: string | null) {
  return appReturnPath(value) ?? "/";
}

function respond(
  response: ServerResponse,
  status: number,
  headers: Record<string, string | string[]> = {},
  body?: string,
) {
  response
    .writeHead(status, {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    })
    .end(body);
}
