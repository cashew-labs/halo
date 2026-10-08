# Workspace server

`@get-halo/workspace-server` is Halo's reusable workspace, agent, integration, and extension service. Hosts import `WorkspaceServer` from the package root and call `WorkspaceServer.start({ config, host })`.

The class owns service construction, the shared database, product HTTP, and cleanup. Private services stay private. Host capabilities on `WorkspaceServerHost` are borrowed: the host owns inference and logging. Integration credentials and OAuth belong to the control plane; the workspace retains Executor for local code execution, tools and approvals.

The Node process that reads launch settings, publishes discovery files, and shuts down lives in `apps/workspace-server` (`@get-halo/workspace-server-app`).
