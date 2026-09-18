# Schema and storage SDK

`schema.ts` default-exports the Tandem schema. The SDK connects the browser client to `/sync/` and stores hosted data in `.halo/extension-data/<id>/store.json`. Never read or write that file directly.

## Schema exports

`@get-halo/extension-sdk/schema` exports `defineSchema`, `collection`, and `t`.

Define collections with field builders:

```ts
import { collection, defineSchema, t } from "@get-halo/extension-sdk/schema";

export default defineSchema({
  tasks: collection({
    id: t.id(),
    label: t.string(),
    priority: t.number(),
    done: t.boolean(),
  }),
});
```

The available builders are:

- `t.id()`: a string ID field. Every collection must have `id`.
- `t.string()`: a string field.
- `t.number()`: a number field.
- `t.boolean()`: a boolean field.

These builders produce required fields. Optional fields, arrays, objects, and relations are not exposed by the current extension schema API. Model optional states explicitly when needed. Do not import Tandem internals to extend the hosted schema contract.

`collection<Record>({ fields })` is an advanced overload for explicitly typed records whose `id` is a string or number. Prefer the field-builder form because it keeps the runtime schema and inferred record type together. The SDK does not re-export Tandem codecs or relation builders.

## Queries

The view's `storage` supports synchronous `query` and reactive `subscribe`. React views should normally use `useQuery`, documented in [view.md](view.md).

A query always names one collection:

```ts
const allTasks = { collection: "tasks" } as const;
```

The complete supported query shape is:

```ts
const visibleTasks = {
  collection: "tasks",
  select: { id: true, label: true },
  where: {
    done: false,
    priority: { gte: 2, lt: 5 },
  },
  orderBy: { priority: "desc", label: "asc" },
  offset: 0,
  limit: 20,
} as const;
```

- `select` includes only fields set to `true` and narrows the inferred row type.
- `where` accepts a direct value for equality or an operator object containing `eq`, `gt`, `lt`, `gte`, and `lte`.
- Multiple fields and multiple operators are combined with AND semantics.
- `orderBy` accepts `asc` or `desc`. Multiple entries are applied in object insertion order.
- `offset` is applied before `limit`.
- Omitting `select` returns the complete record.

The underlying Tandem query type contains relational `with`, but the extension SDK does not expose or connect relation definitions. Do not use `with` in an extension.

Keep a React query object's identity stable. Define static queries at module scope or memoize queries that depend on props or state.

## Direct query and subscription

`storage.query(query)` returns the current rows synchronously.

`storage.subscribe(query, callback)` returns:

```ts
{
  result: CurrentRows;
  destroy: () => void;
}
```

`result` is the initial snapshot; the callback receives later matching snapshots. Call `destroy()` when the consumer stops. In React, use `useQuery` so this lifecycle is handled for you.

## Transactions

Create a transaction, stage one or more operations, and commit it once:

```ts
const tx = storage.transact();
tx.set("tasks", {
  id: crypto.randomUUID(),
  label: "Ship the extension",
  priority: 3,
  done: false,
});
await storage.commit(tx);
```

A transaction provides:

- `get(collection, id)`: returns the current staged record or `undefined`.
- `list(collection)`: returns all current staged records in the collection.
- `set(collection, fullRecord)`: inserts or replaces a record by ID.
- `update(collection, id, updateFn)`: replaces an existing record with the function's returned full record; it does nothing when the ID is missing.
- `remove(collection, id)`: removes an existing record; it does nothing when the ID is missing.
- `cancel()`: discards the transaction instead of committing it.

The mutation methods return the transaction and can be chained. Reads made through the transaction include changes already staged in that transaction.

`storage.commit(tx)` applies the transaction to the local view immediately and pushes it to the extension server. Always await it when the UI needs to report whether synchronization succeeded. A failed push rejects and Tandem rolls back the rejected speculative mutation.

Create a new transaction for a later edit. Do not reuse a transaction after committing or cancelling it.

## State ownership

Use Tandem for extension-owned records that should persist or synchronize between views. Use React state for unfinished input and browser-local UI. Use Halo tools, through `api.ts`, when the source of truth is a workspace file or connected service. Do not mirror connected-service records into Tandem unless the product explicitly needs an extension-owned cache or annotation layer.

The SDK owns connection, disconnection, remote pulling, persistence flushing, and client clearing. Although those methods are present on the underlying `TandemClient` type, extension views should not call them.
