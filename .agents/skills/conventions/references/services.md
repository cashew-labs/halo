# Services

A service is a stateful runtime object, implemented as a class. A host supplies environment capabilities, configuration, and lifecycle. An adapter connects a service to a platform or client. Prefer composition over inheritance.

## Start with the consumer's operation

Judge boundaries by the path from a consumer action to its visible result. Prefer direct flows over chains that bounce between services.

Human UI, agents, CLI, SDK, and MCP should reach the same product operations, with the same validation, state changes, and events. Their transports and permissions may differ; they should not bypass the operation's owning service.

## Give dependencies an owner and a lifetime

A composed service owns its children. Place a shared child at the lowest common owner that needs it. For example, sessions and tools share a database and its transaction coordination:

```ts
// Avoid: separate connections to the same file.
const sessions = new SessionRepo({
  database: new DatabaseClient({ path: databasePath }),
});
const tools = new ToolRuntime({
  database: new DatabaseClient({ path: databasePath }),
});
```

Instead, construct the shared dependency once in the server's startup:

```ts
// Prefer: both children borrow the database owned by the server.
const database = new DatabaseClient({ path: databasePath });
const sessions = new SessionRepo({ database });
const tools = new ToolRuntime({ database });
```

The server opens the database before its consumers and closes them before the database. Both consumers borrow it; the server owns its lifetime. Sharing is not a reason to move the database into a process-global singleton.

Use a constructor for synchronous setup and `start()` or `create()` for fallible asynchronous setup. Construct children in dependency order and register cleanup as resources are acquired, including for failed startup. `using` or `await using` with disposable stacks keeps reverse-order cleanup together with acquisition.

## Let the host supply the environment

Define narrow, service-owned interfaces where filesystem, inference, or platform access varies by host. Hosts implement and supply those capabilities. Share a service when behavior above an interface needs state; do not mirror every third-party API or wrap deterministic helpers.

The host owns its private bridges. Callers supply configuration, not the IPC or browser bridge that the host should construct. Importing a reusable package must not read deployment configuration, touch disk, or start services.

## Keep authority boundaries explicit

Trusted development control and test setup must not grant ordinary product consumers extra authority. Test setup may share the client contract under an explicit `testApi` namespace, gated server-side by a startup option that is disabled by default. A separate test listener is not required just to distinguish setup from product behavior. The controlled host owns its development listener and credentials. Browser or shell operations can still be product capabilities when intended for consumers.
