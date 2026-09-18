# Workspace server

`@get-halo/workspace-server` is Halo's reusable workspace, agent, integration, and extension service. Hosts import `WorkspaceServer` from the package root and call `WorkspaceServer.start({ config, host })`.

The class owns service construction, the shared database, product HTTP, and cleanup. Private services stay private. Host capabilities on `WorkspaceServerHost` are borrowed: the host owns inference, logging, and the credential vault, and must not close the server-owned filesystem passed into `createCredentialVault`.

The Node process that reads launch settings, publishes discovery files, and shuts down lives in `apps/workspace-server` (`@get-halo/workspace-server-app`).
