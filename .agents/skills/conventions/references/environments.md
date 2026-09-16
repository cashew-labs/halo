# Environments

Development, tests, staging, and production mount the same reusable service packages. What changes is the host: its configuration, capabilities, and how the run is controlled.

## Make startup explicit

Select host implementations and configuration at startup, not through environment branches throughout domain code. In particular, avoid reading arguments, environment variables, files, or secrets just by importing a reusable module:

```ts
export const config = await readConfig();
```

Prefer explicit invocation from the host's startup function:

```ts
async function startHost() {
  const config = await readConfig();
  if (config instanceof Error) return config;
  return await Server.start(config);
}
```

Tests can construct the same server with their own configuration without first changing global environment variables to make an import succeed.

## Give each development run its own home

Run real local versions of production services. Give each run isolated, Git-ignored workspace data, databases, logs, and ports. A development CLI owns startup, readiness, inspection, and shutdown of its processes. Keep that authority separate from the product CLI available to workspace agents.

## Share host APIs with tests

Development commands and test fixtures use the same programmatic construction and control APIs. Fixtures call those APIs directly; they do not shell out to the development CLI. The CLI must not depend on a test runner.

Use Turborepo for dependency-aware builds and affected checks. Keep static checks and E2Es separately runnable; run focused E2Es during iteration rather than automatically packaging and testing every app.

## Deploy the same services in dependency order

Staging and production share adapters with different configuration. Deploy required schema changes first, then backends from lowest to highest layer, then clients. For a control-plane/workspace system, activate the control plane before workspace servers, and clients last. Keep migration and rollout details in the project's release plan.
