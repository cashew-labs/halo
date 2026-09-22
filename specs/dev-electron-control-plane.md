# Development Electron through the control plane

## System flow

### Today

```mermaid
flowchart LR
  subgraph dev [Development]
    E1[Electron]
    E1 -->|"fabricated ADC session"| UI1[Renderer identity]
    E1 -->|"read server.json"| W1["workspace /rpc"]
  end
  subgraph prod [Production]
    E2[Electron]
    E2 -->|"browser Google → Better Auth bearer"| CP2[Control plane]
    CP2 -->|"WorkspaceGateway"| W2[workspace server]
  end
  %% ref node:E1 [[apps/electron/src/main/main.ts#createDesktopAuthentication]]
  %% ref node:W1 [[apps/electron/src/main/DesktopAuthentication.ts#createLocalDesktopAuthentication]]
  %% ref node:E2 [[apps/electron/src/main/auth/ControlPlaneAuth.ts#ControlPlaneAuth.getWorkspaceConnection]]
  %% ref node:CP2 [[apps/control-plane/src/workspace/proxy.ts#WorkspaceGateway.serve]]
```

### Wanted: development uses the production path

```mermaid
flowchart LR
  E[Development Electron]
  E -->|"ADC → Better Auth bearer"| CP[Local control plane]
  CP -->|"same /workspace/* proxy"| W[workspace server]
  %% ref node:E [[apps/electron/src/main/main.ts#createDesktopAuthentication]]
  %% ref node:CP [[apps/control-plane/src/workspace/proxy.ts#WorkspaceGateway.serve]]
  %% ref node:W [[apps/control-plane/src/workspace/WorkspaceService.ts#WorkspaceService.getConnection]]
```

Local `WorkspaceService.getConnection` already reads `server.json` and forwards. Electron should stop reading that file in development. The control plane already does.

## Problem overview

Development Electron bypasses the control plane. Production does not. That is the whole change.

## Solution overview

Point development Electron at the local control plane the same way production points at `https://gethalo.dev`: Better Auth bearer, then `/workspace/health` and `/workspace/rpc`. Keep ADC as the way to get that bearer so development still skips browser Google sign-in. Test Electron (`HALO_E2E=1`) stays on `server.json`.

Working backwards from that goal, only three things are missing. Logger work is not one of them.

## Goals

- In development, workspace traffic goes through the locally running control plane `/workspace/*`, not workspace `/rpc`.
- Development identity stays the active ADC principal. No browser Google sign-in.
- Test Electron still discovers the workspace through `server.json`.

## Non-goals

- No logger, JSONL flush, renderer `LoggerProvider`, or `POST /api/logs`.
- No GCP Cloud Logging.
- No change to production Google sign-in or the packaged app.
- Electron still does not start or stop the workspace server.

## Why these pieces (backwards from the goal)

The production path is already:

```callstack
 ControlPlaneAuth.getWorkspaceConnection [[apps/electron/src/main/auth/ControlPlaneAuth.ts#ControlPlaneAuth.getWorkspaceConnection]]
 └── fetch GET {controlPlane}/workspace/health  # Bearer Better Auth token
 └── renderer → {controlPlane}/workspace/rpc
     └── WorkspaceGateway.serve [[apps/control-plane/src/workspace/proxy.ts#WorkspaceGateway.serve]]
         ├── AuthService.getSession [[apps/control-plane/src/auth/AuthService.ts#AuthService.getSession]]  # 401 without a real session
         └── WorkspaceService.getConnection [[apps/control-plane/src/workspace/WorkspaceService.ts#WorkspaceService.getConnection]]
             └── local: read server.json and forward
```

Development today is a different path:

```callstack
 createDesktopAuthentication [[apps/electron/src/main/main.ts#createDesktopAuthentication]]
 └── createLocalDesktopAuthentication [[apps/electron/src/main/DesktopAuthentication.ts#createLocalDesktopAuthentication]]
     ├── createAdcDesktopIdentity [[apps/electron/src/main/auth/createAdcDesktopIdentity.ts#createAdcDesktopIdentity]]  # fake session, never Better Auth
     └── readWorkspaceServerConnection  # renderer → workspace /rpc, skips the gateway
```

To reuse the production path, Electron must use `ControlPlaneAuth.getWorkspaceConnection`. That method only works if two control-plane facts are true:

1. `WorkspaceGateway.serve` accepts the request. It calls `AuthService.getSession`. A fabricated ADC session is not a Better Auth bearer, so the gateway returns 401. Development cannot open browser Google, so the local control plane must mint a real session from the ADC access token (`POST /api/dev/google-session`, local deployment only).
2. The Vite renderer origin is `http://localhost:1420`, not `null`. Gateway CORS today only reflects `Origin: null`. Without allowing the Vite origin, the browser blocks `/workspace/rpc` even with a valid session.

`server.json` stays where it is: the local gateway already reads it. Electron just stops reading it in development.

## Important files, docs, and websites

- [`apps/electron/src/main/main.ts`](../apps/electron/src/main/main.ts) — Development vs production auth choice.
- [`apps/electron/src/main/DesktopAuthentication.ts`](../apps/electron/src/main/DesktopAuthentication.ts) — Direct `server.json` connection used by development and tests.
- [`apps/electron/src/main/auth/createAdcDesktopIdentity.ts`](../apps/electron/src/main/auth/createAdcDesktopIdentity.ts) — Fabricated session. Delete once development uses a real bearer.
- [`apps/electron/src/main/auth/ControlPlaneAuth.ts`](../apps/electron/src/main/auth/ControlPlaneAuth.ts) — Production connection shape to reuse.
- [`apps/control-plane/src/workspace/proxy.ts`](../apps/control-plane/src/workspace/proxy.ts) — Gateway; CORS and session check.
- [`apps/control-plane/src/workspace/WorkspaceService.ts`](../apps/control-plane/src/workspace/WorkspaceService.ts) — Local proxy already uses `server.json`.
- [`apps/control-plane/src/auth/AuthService.ts`](../apps/control-plane/src/auth/AuthService.ts) — Mints a Better Auth session from an ADC access token.
- [`apps/control-plane/src/server/controlPlaneHttp.ts`](../apps/control-plane/src/server/controlPlaneHttp.ts) — HTTP routes, including local `POST /api/dev/google-session`.
- [`apps/control-plane/test/ControlPlane.test.ts`](../apps/control-plane/test/ControlPlane.test.ts) — CORS and session tests.

## Implementation

### Phase 1: Local gateway CORS for the Vite renderer

Done. Production CORS stays `["null"]`. A local deployment also reflects `http://localhost` and `http://127.0.0.1` on `HALO_RENDERER_PORT` (default `1420`), plus `"null"`. `/workspace/*` still returns 401 until a Better Auth bearer exists. That is phase 2.

```callstack
 WorkspaceGateway.serve [[apps/control-plane/src/workspace/proxy.ts#WorkspaceGateway.serve]]
 └── corsHeaders [[apps/control-plane/src/workspace/proxy.ts#corsHeaders]]
-    └── allow only Origin "null" [[proxy:old:272-274]]
+    └── allowlist from ControlPlane [[plane:new:133-146]] [[http:new:104-109]] [[proxy:new:298-311]]
     └── same header on proxied responses [[proxy:new:19-30]]
     └── Vite origin on 401 and OPTIONS [[cors-test:new:189-220]]
```

- [x] Local allowlist: `http://localhost:${HALO_RENDERER_PORT || 1420}`, `http://127.0.0.1:${port}`, `"null"`. Production: `["null"]`.
- [x] Pass that list into `WorkspaceGateway`. Reflect `Access-Control-Allow-Origin` only when the request origin is in the list. Proxied responses use the same check.
- [x] Test Vite origin on 401 `/workspace/health`, OPTIONS `/workspace/rpc`, and no ACAO for a foreign origin.
- [x] `pnpm --filter @get-halo/control-plane test:e2e -- test/ControlPlane.test.ts`
- [x] `pnpm run check-affected`

```source-diff:plane:apps/control-plane/src/server/ControlPlane.ts
diff --git a/apps/control-plane/src/server/ControlPlane.ts b/apps/control-plane/src/server/ControlPlane.ts
index 8c935db..2239691 100644
--- a/apps/control-plane/src/server/ControlPlane.ts
+++ b/apps/control-plane/src/server/ControlPlane.ts
@@ -17,6 +17,7 @@ import type { TraceCloud } from "../traces/TraceCloud.js";
 
 const loopbackHost = "127.0.0.1";
 const cloudRunHost = "0.0.0.0";
+const defaultRendererPort = "1420";
 
 export class ControlPlane {
   private readonly db: DatabaseService;
@@ -92,6 +93,7 @@ export class ControlPlane {
     const requests = serveControlPlaneHttp({
       server: http.server,
       auth,
+      corsOrigins: controlPlaneCorsOrigins(config),
       publicOrigin,
       workspace,
       webRoot,
@@ -128,6 +130,21 @@ function controlPlaneHost(config: ControlPlaneConfig) {
   return config.deployment === "local" ? loopbackHost : cloudRunHost;
 }
 
+function controlPlaneCorsOrigins(config: ControlPlaneConfig) {
+  if (config.deployment !== "local") return ["null"];
+
+  const configuredPort = process.env.HALO_RENDERER_PORT;
+  const rendererPort =
+    configuredPort === undefined || configuredPort === ""
+      ? defaultRendererPort
+      : configuredPort;
+  return [
+    `http://localhost:${rendererPort}`,
+    `http://127.0.0.1:${rendererPort}`,
+    "null",
+  ];
+}
+
 function databaseConfig(config: ControlPlaneConfig): DatabaseConfig {
   if (config.deployment === "local") {
     return {
```

```source-diff:http:apps/control-plane/src/server/controlPlaneHttp.ts
diff --git a/apps/control-plane/src/server/controlPlaneHttp.ts b/apps/control-plane/src/server/controlPlaneHttp.ts
index 959ca83..842eaad 100644
--- a/apps/control-plane/src/server/controlPlaneHttp.ts
+++ b/apps/control-plane/src/server/controlPlaneHttp.ts
@@ -87,6 +87,7 @@ export async function listenControlPlaneHttp(host: string, port: number) {
 export function serveControlPlaneHttp(ctx: {
   server: HttpServer;
   auth: AuthService;
+  corsOrigins: readonly string[];
   publicOrigin: string;
   workspace: WorkspaceService;
   webRoot: string;
@@ -100,7 +101,12 @@ export function serveControlPlaneHttp(ctx: {
       new ResponseHeadersHandlerPlugin(),
     ],
   });
-  const gateway = new WorkspaceGateway({ auth, publicOrigin, workspace });
+  const gateway = new WorkspaceGateway({
+    auth,
+    corsOrigins: ctx.corsOrigins,
+    publicOrigin,
+    workspace,
+  });
 
   server.removeListener("request", respondStarting);
   server.on("request", async (request, response) => {
```

```source-diff:proxy:apps/control-plane/src/workspace/proxy.ts
diff --git a/apps/control-plane/src/workspace/proxy.ts b/apps/control-plane/src/workspace/proxy.ts
index dd5fab0..c4e7c07 100644
--- a/apps/control-plane/src/workspace/proxy.ts
+++ b/apps/control-plane/src/workspace/proxy.ts
@@ -11,6 +11,23 @@ import type {
 
 const workspacePathPrefix = "/workspace";
 const workspaceProxy = createProxyServer();
+const proxyRequestCorsOrigins = new WeakMap<
+  IncomingMessage,
+  readonly string[]
+>();
+
+workspaceProxy.on("proxyRes", (proxyResponse, request) => {
+  const corsOrigins = proxyRequestCorsOrigins.get(request);
+  if (corsOrigins === undefined) return;
+
+  const origin = allowedRequestOrigin(request, corsOrigins);
+  if (origin === undefined) {
+    delete proxyResponse.headers["access-control-allow-origin"];
+    return;
+  }
+
+  proxyResponse.headers["access-control-allow-origin"] = origin;
+});
 
 class WorkspaceGatewayError extends errore.createTaggedError({
   name: "WorkspaceGatewayError",
@@ -29,16 +46,19 @@ export class WorkspaceGateway {
   private readonly identityClients = new Map<string, IdTokenClient>();
 
   private readonly auth: AuthService;
+  private readonly corsOrigins: readonly string[];
   private readonly googleAuth: GoogleAuth;
   private readonly publicOrigin: URL;
   private readonly workspace: WorkspaceService;
 
   constructor(ctx: {
     auth: AuthService;
+    corsOrigins: readonly string[];
     publicOrigin: string;
     workspace: WorkspaceService;
   }) {
     this.auth = ctx.auth;
+    this.corsOrigins = ctx.corsOrigins;
     this.googleAuth = new GoogleAuth();
     this.publicOrigin = new URL(ctx.publicOrigin);
     this.workspace = ctx.workspace;
@@ -46,36 +66,36 @@ export class WorkspaceGateway {
 
   async serve(request: IncomingMessage, response: ServerResponse) {
     if (request.method === "OPTIONS") {
-      respondToPreflight(request, response);
+      respondToPreflight(request, response, this.corsOrigins);
       return;
     }
 
     const session = await this.auth.getSession(requestHeaders(request));
     if (session instanceof Error) {
       console.error(session);
-      respond(request, response, 500);
+      respond(request, response, 500, this.corsOrigins);
       return;
     }
     if (session === undefined) {
-      respond(request, response, 401);
+      respond(request, response, 401, this.corsOrigins);
       return;
     }
 
     const connection = await this.workspace.getConnection(session.user.id);
     if (connection instanceof Error) {
       console.error(connection);
-      respond(request, response, 503);
+      respond(request, response, 503, this.corsOrigins);
       return;
     }
     if (connection === undefined) {
-      respond(request, response, 503);
+      respond(request, response, 503, this.corsOrigins);
       return;
     }
 
     const authorization = await this.getAuthorization(connection);
     if (authorization instanceof Error) {
       console.error(authorization);
-      respond(request, response, 502);
+      respond(request, response, 502, this.corsOrigins);
       return;
     }
 
@@ -84,6 +104,7 @@ export class WorkspaceGateway {
       response,
       origin: connection.origin,
       authorization,
+      corsOrigins: this.corsOrigins,
       publicOrigin: this.publicOrigin,
     });
   }
@@ -173,6 +194,7 @@ export class WorkspaceGateway {
 
 async function forwardWorkspaceRequest(ctx: {
   authorization: string;
+  corsOrigins: readonly string[];
   origin: string;
   publicOrigin: URL;
   request: IncomingMessage;
@@ -185,6 +207,7 @@ async function forwardWorkspaceRequest(ctx: {
     ctx.authorization,
     ctx.publicOrigin,
   );
+  proxyRequestCorsOrigins.set(ctx.request, ctx.corsOrigins);
   const proxied = await workspaceProxy
     .web(ctx.request, ctx.response, {
       target: target.origin,
@@ -196,7 +219,8 @@ async function forwardWorkspaceRequest(ctx: {
   if (!(proxied instanceof Error)) return;
 
   console.error(proxied);
-  if (!ctx.response.headersSent) respond(ctx.request, ctx.response, 502);
+  if (!ctx.response.headersSent)
+    respond(ctx.request, ctx.response, 502, ctx.corsOrigins);
   if (!ctx.response.writableEnded) ctx.response.end();
 }
 
@@ -250,10 +274,11 @@ function requestHeaders(request: IncomingMessage) {
 function respondToPreflight(
   request: IncomingMessage,
   response: ServerResponse,
+  corsOrigins: readonly string[],
 ) {
   response
     .writeHead(204, {
-      ...corsHeaders(request),
+      ...corsHeaders(request, corsOrigins),
       "access-control-allow-headers": "authorization, content-type",
       "access-control-allow-methods": "GET, POST, OPTIONS",
       "access-control-max-age": "3600",
@@ -265,13 +290,25 @@ function respond(
   request: IncomingMessage,
   response: ServerResponse,
   statusCode: number,
+  corsOrigins: readonly string[],
 ) {
-  response.writeHead(statusCode, corsHeaders(request)).end();
+  response.writeHead(statusCode, corsHeaders(request, corsOrigins)).end();
+}
+
+function corsHeaders(request: IncomingMessage, corsOrigins: readonly string[]) {
+  const origin = allowedRequestOrigin(request, corsOrigins);
+  if (origin === undefined) return {};
+  return { "access-control-allow-origin": origin };
 }
 
-function corsHeaders(request: IncomingMessage) {
-  if (request.headers.origin !== "null") return {};
-  return { "access-control-allow-origin": "null" };
+function allowedRequestOrigin(
+  request: IncomingMessage,
+  corsOrigins: readonly string[],
+) {
+  const origin = request.headers.origin;
+  if (origin === undefined || Array.isArray(origin)) return undefined;
+  if (!corsOrigins.includes(origin)) return undefined;
+  return origin;
 }
 
 function respondToUpgrade(socket: Duplex, statusCode: number) {
```

```source-diff:cors-test:apps/control-plane/test/ControlPlane.test.ts
diff --git a/apps/control-plane/test/ControlPlane.test.ts b/apps/control-plane/test/ControlPlane.test.ts
index e0e36cc..facc93d 100644
--- a/apps/control-plane/test/ControlPlane.test.ts
+++ b/apps/control-plane/test/ControlPlane.test.ts
@@ -22,6 +22,7 @@ const testAuth = {
 };
 
 const desktopAuthState = "desktop-auth-state-0123456789abcdef";
+const viteOrigin = "http://localhost:1420";
 
 const controlPlaneTest = test.extend<{
   traceCloud: TraceCloudDriver;
@@ -185,6 +186,39 @@ controlPlaneTest(
   },
 );
 
+controlPlaneTest(
+  "reflects the Vite renderer origin on workspace CORS",
+  async ({ plane }) => {
+    const allowed = await fetch(`${plane.origin}/workspace/health`, {
+      headers: { origin: viteOrigin },
+    });
+    expect(allowed.status).toBe(401);
+    expect(allowed.headers.get("access-control-allow-origin")).toBe(viteOrigin);
+
+    const preflight = await fetch(`${plane.origin}/workspace/rpc`, {
+      method: "OPTIONS",
+      headers: {
+        origin: viteOrigin,
+        "access-control-request-headers": "authorization",
+        "access-control-request-method": "POST",
+      },
+    });
+    expect(preflight.status).toBe(204);
+    expect(preflight.headers.get("access-control-allow-origin")).toBe(
+      viteOrigin,
+    );
+    expect(preflight.headers.get("access-control-allow-headers")).toBe(
+      "authorization, content-type",
+    );
+
+    const rejected = await fetch(`${plane.origin}/workspace/health`, {
+      headers: { origin: "https://evil.example" },
+    });
+    expect(rejected.status).toBe(401);
+    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
+  },
+);
+
 controlPlaneTest("serves Better Auth at /api/auth", async ({ plane }) => {
   const ok = await fetch(`${plane.origin}/api/auth/ok`);
   expect(ok.status).toBe(200);
```

### Phase 2: Mint a Better Auth session from ADC (local only)

Done. `POST /api/dev/google-session` exists only when `deployment === "local"`. It checks the ADC access token, then creates or reuses a Google account and a Better Auth session. Production leaves the route unset, so `/api` returns 404. Development Electron does not call this yet. That is phase 3.

```callstack
 routeControlPlaneRequest [[apps/control-plane/src/server/controlPlaneHttp.ts#routeControlPlaneRequest]]
+└── POST /api/dev/google-session [[session-http:new:232-240]] [[session-plane:new:102]]
+    └── AuthService.signInWithGoogleAccessToken [[session-auth:new:252-292]]
+        ├── OAuth2Client.getTokenInfo [[session-auth:new:387-403]]
+        ├── internalAdapter.findAccountOwnerByKey [[session-auth:new:261-269]]
+        ├── internalAdapter.createOAuthUser [[session-auth:new:367-385]]
+        └── internalAdapter.createSession [[session-auth:new:280-286]]
     └── bearer session and /workspace/health [[session-test:new:238-332]]
```

- [x] `AuthService.signInWithGoogleAccessToken`. Optional verifier injectable for tests.
- [x] Route only when `config.deployment === "local"`. Production 404s `/api/dev/google-session`.
- [x] Test: 400 / 401 / 200, then bearer `auth.session()` and `/workspace/health`.
- [x] `pnpm --filter @get-halo/control-plane test:e2e -- test/ControlPlane.test.ts`
- [x] `pnpm run check-affected`

```source-diff:session-auth:apps/control-plane/src/auth/AuthService.ts
diff --git a/apps/control-plane/src/auth/AuthService.ts b/apps/control-plane/src/auth/AuthService.ts
index 3ac4d74..400f723 100644
--- a/apps/control-plane/src/auth/AuthService.ts
+++ b/apps/control-plane/src/auth/AuthService.ts
@@ -5,6 +5,7 @@ import { getMigrations } from "better-auth/db/migration";
 import { toNodeHandler } from "better-auth/node";
 import { bearer, oneTimeToken } from "better-auth/plugins";
 import * as errore from "errore";
+import { OAuth2Client } from "google-auth-library";
 import type { DatabaseClient, DatabaseService } from "../DatabaseService.js";
 
 const loopbackHost = "127.0.0.1";
@@ -30,12 +31,28 @@ export class InvalidDesktopAuthCodeError extends errore.createTaggedError({
   message: "Desktop sign-in code is invalid or expired",
 }) {}
 
+export class InvalidGoogleAccessTokenError extends errore.createTaggedError({
+  name: "InvalidGoogleAccessTokenError",
+  message: "Google access token is invalid",
+}) {}
+
+type GoogleAccessTokenIdentity = {
+  email: string;
+  name: string;
+  subject: string;
+};
+
+export type GoogleAccessTokenVerifier = (
+  accessToken: string,
+) => Promise<GoogleAccessTokenIdentity | Error>;
+
 type AuthServiceOptions = {
   db: DatabaseService;
   origin: string;
   secret: string;
   googleClientId: string;
   googleClientSecret: string;
+  verifyGoogleAccessToken?: GoogleAccessTokenVerifier;
 };
 
 type DesktopSignInRequest = {
@@ -102,20 +119,27 @@ function authOptions(options: AuthServiceOptions, database: DatabaseClient) {
 
 type AuthOptions = ReturnType<typeof authOptions>;
 type BetterAuth = Auth<AuthOptions>;
+type AuthContext = Awaited<BetterAuth["$context"]>;
+type GoogleAccountOwner = Awaited<
+  ReturnType<AuthContext["internalAdapter"]["findAccountOwnerByKey"]>
+>;
 
 export class AuthService {
   private readonly auth: BetterAuth;
   private readonly nodeHandler: NodeHandler;
   private readonly origin: string;
+  private readonly verifyGoogleAccessToken: GoogleAccessTokenVerifier;
 
   private constructor(ctx: {
     auth: BetterAuth;
     nodeHandler: NodeHandler;
     origin: string;
+    verifyGoogleAccessToken: GoogleAccessTokenVerifier;
   }) {
     this.auth = ctx.auth;
     this.nodeHandler = ctx.nodeHandler;
     this.origin = ctx.origin;
+    this.verifyGoogleAccessToken = ctx.verifyGoogleAccessToken;
   }
 
   static async start(options: AuthServiceOptions) {
@@ -138,6 +162,10 @@ export class AuthService {
       auth,
       nodeHandler: toNodeHandler(auth),
       origin: options.origin,
+      verifyGoogleAccessToken:
+        options.verifyGoogleAccessToken === undefined
+          ? inspectGoogleAccessToken
+          : options.verifyGoogleAccessToken,
     });
   }
 
@@ -214,20 +242,54 @@ export class AuthService {
       });
     if (result instanceof Error) return result;
 
-    return {
+    return serializeDesktopAuthSession({
       token: result.session.token,
-      session: {
-        id: result.session.id,
-        userId: result.session.userId,
-        expiresAt: result.session.expiresAt,
-      },
-      user: {
-        id: result.user.id,
-        email: result.user.email,
-        name: result.user.name,
-        image: result.user.image === null ? undefined : result.user.image,
-      },
-    } satisfies DesktopAuthSession;
+      session: result.session,
+      user: result.user,
+    });
+  }
+
+  async signInWithGoogleAccessToken(accessToken: string) {
+    const identity = await this.verifyGoogleAccessToken(accessToken);
+    if (identity instanceof Error) return identity;
+
+    const context = await this.auth.$context.catch(
+      (cause) => new AuthServiceError({ detail: "load auth context", cause }),
+    );
+    if (context instanceof Error) return context;
+
+    const owner = await context.internalAdapter
+      .findAccountOwnerByKey({
+        providerId: "google",
+        accountId: identity.subject,
+      })
+      .catch(
+        (cause) =>
+          new AuthServiceError({ detail: "find Google account", cause }),
+      );
+    if (owner instanceof Error) return owner;
+
+    const user = await googleUserForIdentity({
+      context,
+      identity,
+      accessToken,
+      owner,
+    });
+    if (user instanceof Error) return user;
+
+    const session = await context.internalAdapter
+      .createSession(user.id)
+      .catch(
+        (cause) =>
+          new AuthServiceError({ detail: "create Google session", cause }),
+      );
+    if (session instanceof Error) return session;
+
+    return serializeDesktopAuthSession({
+      token: session.token,
+      session,
+      user,
+    });
   }
 
   async getSession(headers: Headers) {
@@ -268,6 +330,78 @@ export class AuthService {
   }
 }
 
+function serializeDesktopAuthSession(input: {
+  token: string;
+  session: { id: string; userId: string; expiresAt: Date };
+  user: {
+    id: string;
+    email: string;
+    name: string;
+    image?: string | null;
+  };
+}) {
+  return {
+    token: input.token,
+    session: {
+      id: input.session.id,
+      userId: input.session.userId,
+      expiresAt: input.session.expiresAt,
+    },
+    user: {
+      id: input.user.id,
+      email: input.user.email,
+      name: input.user.name,
+      image: input.user.image === null ? undefined : input.user.image,
+    },
+  } satisfies DesktopAuthSession;
+}
+
+async function googleUserForIdentity(ctx: {
+  accessToken: string;
+  context: AuthContext;
+  identity: GoogleAccessTokenIdentity;
+  owner: GoogleAccountOwner;
+}) {
+  if (ctx.owner !== null && ctx.owner.kind === "owned") return ctx.owner.user;
+
+  const created = await ctx.context.internalAdapter
+    .createOAuthUser(
+      {
+        email: ctx.identity.email,
+        name: ctx.identity.name,
+        emailVerified: true,
+      },
+      {
+        providerId: "google",
+        accountId: ctx.identity.subject,
+        accessToken: ctx.accessToken,
+      },
+    )
+    .catch(
+      (cause) => new AuthServiceError({ detail: "create Google user", cause }),
+    );
+  if (created instanceof Error) return created;
+  return created.user;
+}
+
+async function inspectGoogleAccessToken(accessToken: string) {
+  const tokenInfo = await new OAuth2Client()
+    .getTokenInfo(accessToken)
+    .catch((cause) => new InvalidGoogleAccessTokenError({ cause }));
+  if (tokenInfo instanceof Error) return tokenInfo;
+
+  const email = tokenInfo.email;
+  if (email === undefined) return new InvalidGoogleAccessTokenError();
+  const subject = tokenInfo.sub;
+  if (subject === undefined) return new InvalidGoogleAccessTokenError();
+
+  return {
+    email,
+    name: email,
+    subject,
+  } satisfies GoogleAccessTokenIdentity;
+}
+
 function parseDesktopSignInRequest(request: DesktopSignInRequest) {
   if (!desktopAuthStatePattern.test(request.state)) {
     return new InvalidDesktopSignInRequestError();
```

```source-diff:session-plane:apps/control-plane/src/server/ControlPlane.ts
diff --git a/apps/control-plane/src/server/ControlPlane.ts b/apps/control-plane/src/server/ControlPlane.ts
index 2239691..1279399 100644
--- a/apps/control-plane/src/server/ControlPlane.ts
+++ b/apps/control-plane/src/server/ControlPlane.ts
@@ -1,7 +1,10 @@
 import { join } from "node:path";
 import type { ControlPlaneConfig } from "@get-halo/config/controlPlane";
 import * as errore from "errore";
-import { AuthService } from "../auth/AuthService.js";
+import {
+  AuthService,
+  type GoogleAccessTokenVerifier,
+} from "../auth/AuthService.js";
 import {
   closeControlPlaneHttp,
   type ListeningControlPlaneHttp,
@@ -46,6 +49,7 @@ export class ControlPlane {
     config: ControlPlaneConfig;
     webRoot: string;
     traceCloud?: TraceCloud;
+    verifyGoogleAccessToken?: GoogleAccessTokenVerifier;
   }) {
     const { config, webRoot } = ctx;
     await using cleanup = new errore.AsyncDisposableStack();
@@ -78,6 +82,7 @@ export class ControlPlane {
       secret: config.auth.secret,
       googleClientId: config.auth.googleClientId,
       googleClientSecret: config.auth.googleClientSecret,
+      verifyGoogleAccessToken: ctx.verifyGoogleAccessToken,
     });
     if (auth instanceof Error) return auth;
 
@@ -94,6 +99,7 @@ export class ControlPlane {
       server: http.server,
       auth,
       corsOrigins: controlPlaneCorsOrigins(config),
+      googleAccessTokenSessions: config.deployment === "local",
       publicOrigin,
       workspace,
       webRoot,
```

```source-diff:session-http:apps/control-plane/src/server/controlPlaneHttp.ts
diff --git a/apps/control-plane/src/server/controlPlaneHttp.ts b/apps/control-plane/src/server/controlPlaneHttp.ts
index 842eaad..f396106 100644
--- a/apps/control-plane/src/server/controlPlaneHttp.ts
+++ b/apps/control-plane/src/server/controlPlaneHttp.ts
@@ -13,11 +13,14 @@ import {
   RequestHeadersHandlerPlugin,
   ResponseHeadersHandlerPlugin,
 } from "@orpc/server/plugins";
+import { Type } from "@sinclair/typebox";
+import { Value } from "@sinclair/typebox/value";
 import * as errore from "errore";
 import {
   type AuthService,
   DesktopAuthRequiredError,
   InvalidDesktopSignInRequestError,
+  InvalidGoogleAccessTokenError,
 } from "../auth/AuthService.js";
 import {
   controlPlaneRpcRouter,
@@ -31,6 +34,9 @@ import {
 } from "../workspace/proxy.js";
 
 const requestUrlBase = "http://localhost";
+const googleAccessTokenSessionSchema = Type.Object({
+  accessToken: Type.String({ minLength: 1 }),
+});
 const webContentSecurityPolicy = [
   "base-uri 'none'",
   "connect-src 'self'",
@@ -88,6 +94,7 @@ export function serveControlPlaneHttp(ctx: {
   server: HttpServer;
   auth: AuthService;
   corsOrigins: readonly string[];
+  googleAccessTokenSessions: boolean;
   publicOrigin: string;
   workspace: WorkspaceService;
   webRoot: string;
@@ -114,6 +121,7 @@ export function serveControlPlaneHttp(ctx: {
       request,
       response,
       auth,
+      googleAccessTokenSessions: ctx.googleAccessTokenSessions,
       workspace,
       gateway,
       traces,
@@ -176,6 +184,7 @@ async function routeControlPlaneRequest(ctx: {
   request: IncomingMessage;
   response: ServerResponse;
   auth: AuthService;
+  googleAccessTokenSessions: boolean;
   gateway: WorkspaceGateway;
   traces?: TraceIngestion;
   workspace: WorkspaceService;
@@ -220,6 +229,16 @@ async function routeControlPlaneRequest(ctx: {
     return;
   }
 
+  // Local deployment only. Production leaves the flag unset, so this path 404s.
+  if (
+    ctx.googleAccessTokenSessions &&
+    request.method === "POST" &&
+    url.pathname === "/api/dev/google-session"
+  ) {
+    await serveGoogleAccessTokenSession(request, response, auth);
+    return;
+  }
+
   if (isBetterAuthRequest(url)) {
     await serveBetterAuth(request, response, auth);
     return;
@@ -345,6 +364,59 @@ function serveDesktopAuthError(response: ServerResponse, url: URL) {
     .end(detail);
 }
 
+async function serveGoogleAccessTokenSession(
+  request: IncomingMessage,
+  response: ServerResponse,
+  auth: AuthService,
+) {
+  const body = await readGoogleAccessTokenBody(request);
+  if (body instanceof Error) {
+    response.writeHead(400).end("Invalid Google access token session request.");
+    return;
+  }
+
+  const session = await auth.signInWithGoogleAccessToken(body.accessToken);
+  if (session instanceof InvalidGoogleAccessTokenError) {
+    response.writeHead(401).end("Google access token is invalid.");
+    return;
+  }
+  if (session instanceof Error) {
+    console.error(session);
+    response.writeHead(500).end();
+    return;
+  }
+
+  const payload = Buffer.from(`${JSON.stringify(session)}\n`);
+  response
+    .writeHead(200, {
+      "cache-control": "no-store",
+      "content-length": payload.byteLength,
+      "content-type": "application/json; charset=utf-8",
+    })
+    .end(payload);
+}
+
+async function readGoogleAccessTokenBody(request: IncomingMessage) {
+  const chunks: Uint8Array[] = [];
+  for await (const chunk of request) {
+    chunks.push(Buffer.from(chunk));
+  }
+  const raw = Buffer.concat(chunks).toString("utf8");
+  const parsed = errore.try({
+    // SAFETY: JSON.parse is untyped; googleAccessTokenSessionSchema validates the body.
+    try: () => JSON.parse(raw) as unknown,
+    catch: (cause) =>
+      new ControlPlaneHttpError({ detail: "parse JSON body", cause }),
+  });
+  if (parsed instanceof Error) return parsed;
+  if (!Value.Check(googleAccessTokenSessionSchema, parsed)) {
+    return new ControlPlaneHttpError({
+      detail: "parse JSON body",
+    });
+  }
+  return parsed;
+}
+
 function isBetterAuthRequest(url: URL) {
   return url.pathname === "/api/auth" || url.pathname.startsWith("/api/auth/");
 }
```

```source-diff:session-test:apps/control-plane/test/ControlPlane.test.ts
diff --git a/apps/control-plane/test/ControlPlane.test.ts b/apps/control-plane/test/ControlPlane.test.ts
index facc93d..7659af0 100644
--- a/apps/control-plane/test/ControlPlane.test.ts
+++ b/apps/control-plane/test/ControlPlane.test.ts
@@ -1,6 +1,8 @@
 import { gzipSync } from "node:zlib";
 import { TraceCloudDriver } from "./TraceCloudDriver.js";
 import fs from "node:fs/promises";
+import { createServer, type Server as HttpServer } from "node:http";
+import type { AddressInfo } from "node:net";
 import { join, resolve } from "node:path";
 import { DatabaseSync } from "node:sqlite";
 import { createORPCClient } from "@orpc/client";
@@ -9,10 +11,14 @@ import {
   controlPlaneProtocolVersion,
   type ControlPlaneClient,
 } from "@get-halo/shared/controlPlaneContract";
+import { writeWorkspaceServerConnection } from "@get-halo/shared/WorkspaceServerConnection";
+import { Type } from "@sinclair/typebox";
+import { Value } from "@sinclair/typebox/value";
 import { betterAuth } from "better-auth";
 import { testUtils } from "better-auth/plugins";
 import * as errore from "errore";
 import { expect, test } from "vitest";
+import { InvalidGoogleAccessTokenError } from "../src/auth/AuthService.js";
 import { ControlPlane } from "../src/server/ControlPlane.js";
 
 const testAuth = {
@@ -23,6 +29,15 @@ const testAuth = {
 
 const desktopAuthState = "desktop-auth-state-0123456789abcdef";
 const viteOrigin = "http://localhost:1420";
+const googleSessionResponse = Type.Object(
+  {
+    token: Type.String({ minLength: 1 }),
+    user: Type.Object({
+      email: Type.String(),
+    }),
+  },
+  { additionalProperties: true },
+);
 
 const controlPlaneTest = test.extend<{
   traceCloud: TraceCloudDriver;
@@ -219,6 +234,104 @@ controlPlaneTest(
   },
 );
 
+controlPlaneTest(
+  "exchanges a Google access token for a bearer workspace session",
+  async ({ appDataDir, webRoot }) => {
+    await using cleanup = new errore.AsyncDisposableStack();
+    const plane = await ControlPlane.start({
+      config: {
+        deployment: "local",
+        workspace: { deployment: "local" },
+        appDataDir,
+        port: 0,
+        auth: testAuth,
+      },
+      webRoot,
+      verifyGoogleAccessToken: async (accessToken) => {
+        if (accessToken !== "adc-access-token") {
+          return new InvalidGoogleAccessTokenError();
+        }
+        return {
+          email: "adc@example.com",
+          name: "ADC User",
+          subject: "adc-subject-1",
+        };
+      },
+    });
+    if (plane instanceof Error) throw plane;
+    cleanup.defer(async () => {
+      const closed = await plane.close();
+      if (closed instanceof Error) console.warn(closed);
+    });
+
+    const invalidBody = await fetch(`${plane.origin}/api/dev/google-session`, {
+      method: "POST",
+      headers: { "content-type": "application/json" },
+      body: JSON.stringify({}),
+    });
+    expect(invalidBody.status).toBe(400);
+
+    const invalidToken = await fetch(`${plane.origin}/api/dev/google-session`, {
+      method: "POST",
+      headers: { "content-type": "application/json" },
+      body: JSON.stringify({ accessToken: "nope" }),
+    });
+    expect(invalidToken.status).toBe(401);
+
+    const created = await fetch(`${plane.origin}/api/dev/google-session`, {
+      method: "POST",
+      headers: { "content-type": "application/json" },
+      body: JSON.stringify({ accessToken: "adc-access-token" }),
+    });
+    expect(created.status).toBe(200);
+    // SAFETY: Response.json is untyped; googleSessionResponse validates the session payload.
+    const session = (await created.json()) as unknown;
+    if (!Value.Check(googleSessionResponse, session)) {
+      throw new Error("Google access token session response was invalid");
+    }
+    expect(session.user.email).toBe("adc@example.com");
+
+    const authenticated = createControlPlaneRpcClient(
+      plane.origin,
+      session.token,
+    );
+    expect(await authenticated.auth.session()).toMatchObject({
+      status: "signed-in",
+      session: { user: { email: "adc@example.com" } },
+    });
+
+    const workspaceServer = createServer((_request, response) => {
+      response.writeHead(200).end("workspace healthy");
+    });
+    await listenOnLoopback(workspaceServer);
+    cleanup.defer(async () => {
+      await closeServer(workspaceServer);
+    });
+
+    // SAFETY: Node returns a TCP address after successfully listening with a numeric port.
+    const address = workspaceServer.address() as AddressInfo;
+    const published = await writeWorkspaceServerConnection({
+      appDataDir,
+      connection: {
+        workspaceRoot: "/test/workspace",
+        origin: `http://127.0.0.1:${address.port}`,
+        token: "local-workspace-token",
+      },
+    });
+    if (published instanceof Error) throw published;
+
+    const health = await fetch(`${plane.origin}/workspace/health`, {
+      headers: {
+        authorization: `Bearer ${session.token}`,
+        origin: viteOrigin,
+      },
+    });
+    expect(health.status).toBe(200);
+    expect(await health.text()).toBe("workspace healthy");
+    expect(health.headers.get("access-control-allow-origin")).toBe(viteOrigin);
+  },
+);
+
 controlPlaneTest("serves Better Auth at /api/auth", async ({ plane }) => {
   const ok = await fetch(`${plane.origin}/api/auth/ok`);
   expect(ok.status).toBe(200);
@@ -365,6 +478,22 @@ controlPlaneTest(
   },
 );
 
+async function listenOnLoopback(server: HttpServer) {
+  await new Promise<void>((resolveListen, rejectListen) => {
+    server.once("error", rejectListen);
+    server.listen(0, "127.0.0.1", () => {
+      server.off("error", rejectListen);
+      resolveListen();
+    });
+  });
+}
+
+async function closeServer(server: HttpServer) {
+  await new Promise<void>((resolveClose) => {
+    server.close(() => resolveClose());
+  });
+}
+
 function createControlPlaneRpcClient(origin: string, token?: string | Headers) {
   const link = new RPCLink({
     origin,
```

### Phase 3: Development Electron uses ControlPlaneAuth

This is the user-visible switch. Development starts `ControlPlaneAuth` with an in-memory `createSession` that POSTs the ADC token. `getWorkspaceConnection` is already `/workspace/rpc`. Delete `createAdcDesktopIdentity`. Leave Test on `createLocalDesktopAuthentication`.

```callstack
 createDesktopAuthentication [[apps/electron/src/main/main.ts#createDesktopAuthentication]]
 ├── Test → createLocalDesktopAuthentication  # unchanged, server.json
 ├── Development
-│   └── createLocalDesktopAuthentication + createAdcDesktopIdentity  # workspace /rpc
+│   └── ControlPlaneAuth.start({ origin, createSession })
+│       ├── createGoogleAccessTokenSession  # POST /api/dev/google-session
+│       └── getWorkspaceConnection  # already /workspace/rpc
 └── production → ControlPlaneAuth.start({ origin, dataDir })  # unchanged
```

- [ ] `createGoogleAccessTokenSession({ origin })` in Electron main.
- [ ] `ControlPlaneAuth.start` union: disk `dataDir` or in-memory `createSession` (no `safeStorage`).
- [ ] Development uses that start mode. Remove `createAdcDesktopIdentity.ts`.
- [ ] README / AGENTS: development Electron uses `/workspace/*`; `server.json` is for the local gateway and Test Electron.
- [ ] `pnpm run check-affected`. Smoke `pnpm dev`: renderer calls `{controlPlane}/workspace/rpc`, not workspace `/rpc`.
