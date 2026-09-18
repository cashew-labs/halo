# Workspace server

`apps/workspace-server` (`@get-halo/workspace-server-app`) is the Node process that
runs Halo's workspace server. It reads launch settings, supplies host capabilities,
starts `WorkspaceServer` from `@get-halo/workspace-server`, and publishes discovery
files. Electron is an HTTP client: it neither starts nor stops this process.

## Development

Start the complete local application from the repository root:

```sh
pnpm dev
```

Turbo starts the control plane, workspace server, and Electron as separate
development services. They share `<repo>/tmp/workspace` as the workspace and
`<repo>/tmp/workspace/.halo` as application data. The services read development
secrets from GCP Secret Manager through Application Default Credentials.

Electron waits for the server to publish its connection. Closing Electron
leaves the server, active conversations, and extensions running. To change
workspaces, restart the server with a different `HALO_WORKSPACE_ROOT` and reload
Electron.

### Control the development app

Electron main starts an app-control endpoint on a separate loopback port in
development. It publishes its own bearer token in `appControl.json` under
Electron's local application data directory, with mode `0600`. Quitting Electron
closes the listener and removes the file. The workspace server does not host app
control, and production and test-mode Electron do not create this endpoint.

App screenshots are stored locally under `<Electron dataDir>/app/screenshots`,
even when the workspace server is remote. Workspace browser screenshots remain
under `<workspace>/.halo/browser/screenshots`.

From the repository root, inspect the running development app with:

```sh
pnpm halo-dev app snapshot
```

`halo-dev app` reads `HALO_APP_CONTROL_FILE` when set, otherwise `HALO_USER_DATA`,
otherwise the nearest `.halo/appControl.json` above the current directory. It
does not use `rpc.json` or `HALO_RPC_FILE`. The product CLI and renderer tokens
do not authorize app control. The separate `halo` CLI is for workspace agents;
its browser and extension commands use the product connection, and it has no
app-control commands.

## Production workspace container

The durable workspace disk directory `/mnt/halo/workspace` is mounted directly
at `/home/node`. The container runs as the `node` user, whose Unix home and Halo
workspace root are both `/home/node`. User files, application data, agent state,
configuration, user-installed packages, and user binaries therefore share one
persistent filesystem tree. `/tmp`, `/run`, running processes, and image system
paths remain ephemeral.

The image configures npm, Python, and Go user installations beneath
`/home/node`. `/home/node/.local/bin` and `/home/node/.halo/bin` are on `PATH` for
the server, agents, and extensions. System dependencies must be added to the
image instead of installed in a running workspace.

Before the first rollout of this layout, copy the existing production
container's `/home/node` contents—especially `.local` and `.config`—into
`/mnt/halo/workspace`. Do this before replacing the container. The startup script
does not perform this one-time migration.

## Explicit launch configuration

Start only the server with a JSON configuration file:

```sh
pnpm server /absolute/path/to/config.json
```

```json
{
  "environment": "local",
  "workspaceRoot": "/absolute/path/to/workspace",
  "appDataDir": "/absolute/path/to/user-data",
  "appVersion": "0.0.0",
  "ownerUserId": "local-user",
  "port": 8788,
  "logFilePath": "/absolute/path/to/user-data/logs/server.jsonl",
  "corsOrigins": ["http://localhost:1420", "null"]
}
```

Electron must use the same `appDataDir` through `HALO_USER_DATA`. Packaged
Electron also accepts its `--user-data-dir` argument. The server binds to loopback on the configured port
and publishes `server.json` for the local control-plane gateway and `rpc.json` for the CLI. These files
contain distinct local bearer credentials and are written with mode `0600`.
Graceful server shutdown removes both files. Desktop reload reads the latest
connection, including after a server restart.

`HALO_LLM_CONFIG` selects the existing OpenAI-compatible inference transport.
Otherwise the process uses the same local Pi provider/model configuration as
before. See [the inference boundary](../../packages/workspace-server/src/llm/README.md).

## Credential storage

`FileCredentialVault` stores credential values as plain files under
`<workspace>/.halo/executor/credentials`, with directory mode `0700` and file
mode `0600`. Filenames are hashes of credential IDs. This filesystem-backed
store has no Electron or OS-keyring dependency; credentials will move to the
control plane in a later phase. Existing encrypted credential files are not
migrated.

## Test setup

The existing workspace `serverTest` and Electron `e2eTest` fixtures start the same `WorkspaceServer` used by the app, with temporary data and controlled inference. The normal client exposes `testApi.seedSession`, `testApi.invokeTool`, and `testApi.getToolIdentity`. A shared server-side gate rejects these operations unless `WorkspaceServer.start` receives `config.testApiEnabled: true`. Omission disables them. Tests prepare state through these semantic operations, not internal database records, then observe it through ordinary product RPC or the UI.

Electron's fixture launches the same `src/main.ts` as normal runs. The app enables `testApi` only in `ApplicationMode.Test`; development and production leave it disabled. The fixture receives the normal server readiness through child-process IPC and creates an ordinary client. There is no separate test host, entry point, listener, token, contract, or client implementation.

## Ownership

`WorkspaceServer` lives in `@get-halo/workspace-server`. It owns service construction, the shared database, product HTTP, and cleanup; there is no separate runtime object or public bag of child services. The app's `main.ts` reads launch settings, supplies inference, credentials, bind address, and executable choices, calls `WorkspaceServer.start({ config, host })`, and owns discovery files and process shutdown. Tests construct the same class through the package root.

```text
pnpm dev
├── control-plane: tsx watch src/main.ts
│   └── publish local connection information
├── workspace-server: tsx watch src/main.ts
│   ├── readWorkspaceServerApplicationConfig()
│   ├── WorkspaceServer.start({ config, host })
│   └── publish product connection files
└── Electron
    ├── ControlPlaneAuth → /workspace/rpc (development and production)
    └── AppControlServer.start() → publish local appControl.json (development only)
```

The server retains the existing workspace files, conversation database, and
service APIs. Hosted integrations, hosted inference, and cloud provisioning are
separate work.
