# Schema and storage SDK

`schema.ts` named-exports its Tandem `schema` and `relations` definitions. The SDK connects the browser client to `/sync/`, where one `TandemServer` persists hosted data through `TandemServerJsonFileStorage` at `.halo/extension-data/<id>/tandem.json`. The tuple file is an SDK-owned implementation detail; never read or write it directly. An extension rebuilt from the earlier runtime starts a fresh `tandem.json` and leaves any legacy `store.json` untouched and recoverable.

## Schema exports

`@get-halo/extension-sdk/schema` exports `defineSchema`, `defineRelations`, `collection`, and `t`.

Define collections with field builders:

```ts
import {
  collection,
  defineRelations,
  defineSchema,
  t,
} from "@get-halo/extension-sdk/schema";

export const schema = defineSchema({
  projects: collection({
    id: t.id(),
    name: t.string(),
  }),
  tasks: collection({
    id: t.id(),
    projectId: t.string(),
    label: t.string(),
    priority: t.number(),
    done: t.boolean(),
  }),
});

export const relations = defineRelations(schema, ({ one, many }) => ({
  projects: {
    tasks: many("tasks", { from: "id", to: "projectId" }),
  },
  tasks: {
    project: one("projects", { from: "projectId", to: "id" }),
  },
}));
```

The available builders are:

- `t.id()`: a string ID field. Every collection must have `id`.
- `t.string()`: a string field.
- `t.number()`: a number field.
- `t.boolean()`: a boolean field.

These builders produce required fields. Optional fields, arrays, and objects are not exposed by the current extension schema API. Model optional states explicitly when needed. Do not import Tandem internals to extend the hosted schema contract.

Define relations after the schema so Tandem can validate collection and field names. `one` adds a many-to-one relation whose query result is one target record or `null`; `many` adds a one-to-many relation whose result is an array. In both cases, `from` names the source collection field and `to` names the target collection field. Export the definitions as `schema` and `relations`; the generated browser entry imports those exact names.

`collection<Record>({ fields })` is an advanced overload for explicitly typed records whose `id` is a string or number. Prefer the field-builder form because it keeps the runtime schema and inferred record type together. The SDK does not re-export Tandem codecs.

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
  with: {
    project: { select: { id: true, name: true } },
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
- `with` includes relations declared for the queried collection. Use `true` for every target field or a nested query options object for `select`, `where`, `with`, `orderBy`, `offset`, and `limit` on that relation.

Relation names and nested results are inferred from the exported `relations` definition. A relation created with `one` returns a record or `null`; a relation created with `many` returns an array. Nested `with` clauses can follow relations exposed by the target collection.

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
