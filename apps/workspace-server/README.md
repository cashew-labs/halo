# Workspace server

`apps/workspace-server` runs Halo's workspace, agent, integrations, and extensions in
an independent Node process. Its workspace package name is `@get-halo/workspace-server`.
Electron is an HTTP client: it neither starts nor stops this process.

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
and publishes `server.json` for Electron and `rpc.json` for the CLI. These files
contain distinct local bearer credentials and are written with mode `0600`.
Graceful server shutdown removes both files. Desktop reload reads the latest
connection, including after a server restart.

`HALO_LLM_CONFIG` selects the existing OpenAI-compatible inference transport.
Otherwise the process uses the same local Pi provider/model configuration as
before. See [the inference boundary](src/llm/README.md).

## Credential storage

`FileCredentialVault` stores credential values as plain files under
`<workspace>/.halo/executor/credentials`, with directory mode `0700` and file
mode `0600`. Filenames are hashes of credential IDs. This filesystem-backed
store has no Electron or OS-keyring dependency; credentials will move to the
control plane in a later phase. Existing encrypted credential files are not
migrated.

## Ownership

```text
pnpm dev
├── control-plane: tsx watch src/main.ts
│   └── publish local connection information
├── workspace-server: tsx watch src/main.ts
│   ├── read launch configuration
│   ├── HaloServer.start()
│   └── publish local connection files
└── Electron
    └── read server.json → connect over HTTP RPC
```

The server retains the existing workspace files, conversation database, and
service APIs. Hosted integrations, hosted inference, and cloud provisioning are
separate work.
