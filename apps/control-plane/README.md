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

## Workspace providers

`workspace/provider/WorkspaceProviderApi.ts` defines provisioning and connection
lookup. Implementations live in `workspace/provider/gcp/`,
`workspace/provider/local/`, and `workspace/provider/exe/`. Providers own resource
lookup and connection details; `WorkspaceService` owns workspace identity and
database records.

The process entry point chooses one `workspaceProvider` for the control-plane
instance: GCP in production, or local in development. It passes that implementation
through `ControlPlane.start` to `WorkspaceService`. Provider selection is fixed
at startup and is not stored per workspace.

`workspace.ensure` and gateway connection lookup delegate directly to that
provider. Gateway traffic can create the user's database record before an explicit
ensure, but connection lookup does not provision or wake a VM. The workspace
database schema is unchanged.

`pause` and `resume` are optional provider capabilities. GCP leaves both undefined;
local workspaces are managed by the development host. Exe implements native pause
and resume. Automatic idle handling is later work. Provider connection credentials
are never sent to app clients.

### Exe

Opt in through the JSON configuration's `workspace` field:

```json
{
  "deployment": "exe",
  "templateVmName": "halo-empty-template",
  "privateKeyPath": "/run/secrets/exe-ssh-key",
  "gatewaySecret": "<random secret of at least 32 characters>"
}
```

The private key must be registered with the Exe account and readable by the
control-plane process. The control-plane image includes `ssh-keygen`, used to sign
short-lived API and VM HTTPS credentials locally. It never starts an SSH agent.

Prepare an empty Exe VM with `infra/workspace/exeTemplate.sh IMAGE`, with
`desktop-seccomp.json` alongside the script. The image must contain the workspace
server and desktop stack. The script installs Docker and a service that starts
only after assignment. It persists the whole `/home/node` directory, including
documents and Chrome's profile. Do not put user data or an assignment into the
template. Keep ingress private.

Provisioning clones that template into `halo-<workspaceId>`, assigns its owner and
a derived gateway token, and starts the service. Concurrent requests reuse the
same named VM. `ensure` starts provisioning; clients still wait for workspace
readiness. Lookup alone does not wake a paused VM. Both Exe ingress authorization
and the per-workspace gateway token are required for HTTP and WebSocket traffic.
The gateway secret stays on the control plane; rotating it requires updating
existing VM assignments explicitly.

Before production rollout, move shared secret loading, model inference, and Google
OAuth client-secret operations behind the control plane. Workspace VMs run
untrusted user code and must not receive Halo's GCP credentials or shared provider
keys. Those control-plane endpoints and their workspace-scoped authorization are
not implemented yet; the current normal workspace bootstrap still reads GCP
Secret Manager directly. `/etc/halo/workspace.env` supplies the container
environment, but must not be used to distribute shared credentials as a workaround.

The desktop validation uses the real workspace services with synthetic
inference/OAuth dependencies and does not verify production model calls. Exe trace
upload needs workspace-scoped authentication instead of the existing GCP VM
identity check. Automatic idle policy will follow in a separate PR. Production
deployment configuration and lookup caching remain separate work.

Exe tests use the actual Exe API and a disposable VM, with no simulated Exe host.
They are skipped unless `HALO_EXE_TEST_CONFIG` points to a private JSON file with
`privateKeyPath`, `knownHostsPath`, `templateVmName`, and `gatewaySecret`. Use absolute
paths and a verified SSH known-hosts file. The template must be empty and have a
working Halo desktop image; full production startup remains blocked on the auth
work described above. The test creates a billed VM and deletes only its own clone.

```sh
HALO_EXE_TEST_CONFIG=/absolute/path/to/private-exe-test.json \
  pnpm --filter @get-halo/control-plane test:exe
```
