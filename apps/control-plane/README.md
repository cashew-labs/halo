# Control plane

Halo's control plane serves the browser app, authentication, typed RPC, and the
authenticated workspace gateway. In development it listens on loopback port
`8787` and uses SQLite. `GET /health` returns 200. Auth lives at `/api/auth/*`
through Better Auth with Google sign-in, and workspace traffic uses
`/workspace/*`.

Run from the repository root:

```sh
pnpm --filter @get-halo/control-plane dev
pnpm --filter @get-halo/control-plane start
```

`dev` watches for source changes. Run `pnpm --filter @get-halo/web-app dev` in
parallel to rebuild the browser assets. The root `pnpm dev` command runs both.
Both stay running until interrupted. Application data defaults to `<repo>/.halo`;
set `HALO_USER_DATA` to use a different directory.
Pass a JSON configuration file as the first argument to provide a configuration
that matches the `ControlPlaneConfig` schema in
`packages/config/src/controlPlane.ts` explicitly.

Development reads these secrets from GCP Secret Manager through Application
Default Credentials:

- `halo-dev-local-better-auth-secret`
- `halo-west-control-plane-google-client-id`
- `halo-west-control-plane-google-client-secret`

Google Cloud Console redirect URI: `{origin}/api/auth/callback/google`. In
development that is `http://127.0.0.1:8787/api/auth/callback/google`.

## Cloud Run

The production container listens on `0.0.0.0:$PORT`, uses PostgreSQL, and does
not publish a local discovery file. Cloud Run provides `K_SERVICE` and `PORT`;
configure these additional non-secret variables:

- `BETTER_AUTH_URL`: the service's generated `https://*.run.app` URL
- `DATABASE_URL_SECRET_ID`
- `BETTER_AUTH_SECRET_ID`
- `GOOGLE_CLIENT_ID_SECRET_ID`
- `GOOGLE_CLIENT_SECRET_ID`

The process calls GCP Secret Manager for each value at startup through its
attached service account.

Build `apps/control-plane/Dockerfile` from the repository root. The Google OAuth
redirect URI is `${BETTER_AUTH_URL}/api/auth/callback/google`.
