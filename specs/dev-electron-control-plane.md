# Development Electron through the control plane

## System flow

### Development and production

```mermaid
flowchart LR
  E[Development Electron]
  E -->|"ADC → Better Auth bearer"| CP[Local control plane]
  CP -->|"same /workspace/* proxy"| W[workspace server]
  %% ref node:E [[apps/electron/src/main/main.ts#createDesktopAuthentication]]
  %% ref node:CP [[apps/control-plane/src/workspace/proxy.ts#WorkspaceGateway.serve]]
  %% ref node:W [[apps/control-plane/src/workspace/WorkspaceService.ts#WorkspaceService.getConnection]]
```

Development Electron posts the ADC access token to the local control plane, then uses `ControlPlaneAuth.getWorkspaceConnection`. Local `WorkspaceService.getConnection` still reads `server.json` and forwards. Test Electron (`HALO_E2E=1`) still reads `server.json` itself.

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

Development now uses that path. It used to fabricate an ADC session and read `server.json` directly.

To reuse the production path, Electron uses `ControlPlaneAuth.getWorkspaceConnection`. That method only works if two control-plane facts are true:

1. `WorkspaceGateway.serve` accepts the request. It calls `AuthService.getSession`. A fabricated ADC session is not a Better Auth bearer, so the gateway returns 401. Development cannot open browser Google, so the local control plane mints a real session from the ADC access token (`POST /api/dev/google-session`, local deployment only).
2. The Vite renderer origin is `http://localhost:1420`, not `null`. The local gateway allowlist includes that origin plus `127.0.0.1` and `"null"`. Production still reflects only `Origin: null`.

`server.json` stays where it is: the local gateway reads it. Development Electron does not.

## Important files, docs, and websites

- [`apps/electron/src/main/main.ts`](../apps/electron/src/main/main.ts) — Development vs production auth choice.
- [`apps/electron/src/main/DesktopAuthentication.ts`](../apps/electron/src/main/DesktopAuthentication.ts) — Direct `server.json` connection used by Test Electron.
- [`apps/electron/src/main/auth/createGoogleAccessTokenSession.ts`](../apps/electron/src/main/auth/createGoogleAccessTokenSession.ts) — Posts the ADC access token to the local control plane.
- [`apps/electron/src/main/auth/ControlPlaneAuth.ts`](../apps/electron/src/main/auth/ControlPlaneAuth.ts) — Production disk session, or an in-memory `createSession` in development.
- [`apps/control-plane/src/workspace/proxy.ts`](../apps/control-plane/src/workspace/proxy.ts) — Gateway; CORS and session check.
- [`apps/control-plane/src/workspace/WorkspaceService.ts`](../apps/control-plane/src/workspace/WorkspaceService.ts) — Local proxy already uses `server.json`.
- [`apps/control-plane/src/auth/AuthService.ts`](../apps/control-plane/src/auth/AuthService.ts) — Mints a session from an ADC access token.
- [`apps/control-plane/src/server/controlPlaneHttp.ts`](../apps/control-plane/src/server/controlPlaneHttp.ts) — HTTP routes.
- [`apps/control-plane/test/ControlPlane.test.ts`](../apps/control-plane/test/ControlPlane.test.ts) — CORS and session tests.

## Implementation

### Phase 1: Local gateway CORS for the Vite renderer

The renderer calls `/workspace/rpc` cross-origin. Production CORS stays `["null"]`.

```callstack
 WorkspaceGateway.serve [[apps/control-plane/src/workspace/proxy.ts#WorkspaceGateway.serve]]
 └── corsHeaders [[apps/control-plane/src/workspace/proxy.ts#corsHeaders]]
     └── allowlist from ControlPlane  # local: localhost/127.0.0.1 renderer port + "null"
```

- [x] Local allowlist: `http://localhost:${HALO_RENDERER_PORT || 1420}`, `http://127.0.0.1:${port}`, `"null"`. Production: `["null"]`.
- [x] Pass that list into `WorkspaceGateway`. Reflect `Access-Control-Allow-Origin` only when the request origin is in the list.
- [x] Test Vite origin on 401 `/workspace/health`, OPTIONS `/workspace/rpc`, and no ACAO for a foreign origin.
- [x] `pnpm --filter @get-halo/control-plane test:e2e -- test/ControlPlane.test.ts`
- [x] `pnpm run check-affected`

### Phase 2: Mint a Better Auth session from ADC (local only)

Needed so `WorkspaceGateway` sees the same kind of bearer production uses, without browser Google.

```callstack
 routeControlPlaneRequest [[apps/control-plane/src/server/controlPlaneHttp.ts#routeControlPlaneRequest]]
 └── POST /api/dev/google-session  # only when deployment === "local"
     └── AuthService.signInWithGoogleAccessToken [[apps/control-plane/src/auth/AuthService.ts#AuthService.signInWithGoogleAccessToken]]
         ├── OAuth2Client.getTokenInfo
         ├── internalAdapter.findAccountOwnerByKey
         ├── internalAdapter.createOAuthUser
         └── internalAdapter.createSession
```

- [x] `AuthService.signInWithGoogleAccessToken`. Optional verifier injectable for tests.
- [x] Route only when `config.deployment === "local"`. Production 404s `/api/dev/google-session`.
- [x] Test: 400 / 401 / 200, then bearer `auth.session()` and `/workspace/health`.
- [x] `pnpm --filter @get-halo/control-plane test:e2e -- test/ControlPlane.test.ts`
- [x] `pnpm run check-affected`

### Phase 3: Development Electron uses ControlPlaneAuth

Development starts `ControlPlaneAuth` with an in-memory `createSession` that POSTs the ADC token. `getWorkspaceConnection` is `/workspace/rpc`. `createAdcDesktopIdentity` is gone. Test stays on `createLocalDesktopAuthentication`.

```callstack
 createDesktopAuthentication [[apps/electron/src/main/main.ts#createDesktopAuthentication]]
 ├── Test → createLocalDesktopAuthentication  # server.json
 ├── Development
 │   └── ControlPlaneAuth.start({ origin, createSession }) [[apps/electron/src/main/auth/ControlPlaneAuth.ts#ControlPlaneAuth.start]]
 │       ├── createGoogleAccessTokenSession [[apps/electron/src/main/auth/createGoogleAccessTokenSession.ts#createGoogleAccessTokenSession]]  # POST /api/dev/google-session
 │       └── getWorkspaceConnection [[apps/electron/src/main/auth/ControlPlaneAuth.ts#ControlPlaneAuth.getWorkspaceConnection]]  # /workspace/rpc
 └── production → ControlPlaneAuth.start({ origin, dataDir })
```

- [x] `createGoogleAccessTokenSession({ origin })` in Electron main.
- [x] `ControlPlaneAuth.start` union: disk `dataDir` or in-memory `createSession` (no `safeStorage`).
- [x] Development uses that start mode. Remove `createAdcDesktopIdentity.ts`.
- [x] README / AGENTS: development Electron uses `/workspace/*`; `server.json` is for the local gateway and Test Electron.
- [x] `pnpm run check-affected`
- [ ] Smoke `pnpm dev`: renderer calls `{controlPlane}/workspace/rpc`, not workspace `/rpc`.
