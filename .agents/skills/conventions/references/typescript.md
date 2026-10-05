# TypeScript

## Choose the simplest representation

Use classes for stateful services and functions that act on their arguments for helpers. Group related functions with ES modules and namespace imports; a TypeScript namespace is not needed for grouping alone.

Prefer explicit, straightforward code. Prefer declarative data when it makes the policy clear: a route table expresses routing more directly than a long chain of pathname conditions. Remove nearby dead code and indirection as you work. After removing an unnecessary abstraction, remove the variables, branches, helpers, and comments that only supported it. Add guards, retries, fallback values, `||` or `??` defaults, and defensive checks only for known requirements owned by that code. When handling a known external quirk, add a short comment that identifies its source.

Keep local worries local. Do not compensate in one place for unrelated behavior owned somewhere else; identify the ownership boundary and fix the design there. Do not preserve migrations or backwards compatibility unless the task explicitly requires them. Halo is unreleased and pre-1.0, so rebuild obsolete state instead of carrying compatibility paths.

## Make ownership visible in the code

Keep types with the implementation that owns them. Use strict types, including `noUncheckedIndexedAccess`, and avoid `any`. Use `undefined` for absence, retaining `null` only at external APIs that require it, such as JSON, DOM, Electron, or Cap'n Web. Compare required `null` values explicitly with `=== null`.

Use PascalCase for classes, types, interfaces, enums, and React components. Use camelCase for functions and values. Name a file after its primary export with the same casing and no hyphens; tests mirror the implementation file's name. When a module has no single primary export, name it after the shared concept in camelCase, or use one lowercase word when the folder provides enough context. Use one lowercase word for folders when practical, organize services with their domain helpers, and retain framework-required names. TypeScript ESM imports use `.js` extensions.

Name variables and parameters that hold identifiers with an entity-specific `Id` suffix, such as `sessionId` or `readCursorId`. Avoid ambiguous identifier names such as `session`, `cursor`, `result`, or bare `id` when the value is specifically an identifier and a clearer entity name is available.

Within a class, declare and briefly explain owned state first, then explicit `private readonly` dependencies. Prefer TypeScript `private` and `private readonly` fields over `#` fields. Constructors take one `ctx` object, destructure it, and explicitly assign fields rather than retaining the whole context or using constructor parameter properties. Other comments should explain external quirks or decisions, not repeat the code.

## Return expected failures with `errore`

Use the `errore` package for error handling. Expected failures are part of the function's return type: `Value | DomainError`, not thrown exceptions or `Result` wrappers. Callers check `instanceof Error` and return early, keeping the success path flat.

Define domain errors beside their owning implementation with `errore.createTaggedError`. Always use a namespace import:

```ts
import * as errore from "errore";

class ConfigError extends errore.createTaggedError({
  name: "ConfigError",
  message: "Configuration failed: $detail",
}) {}
```

Return these errors for expected app failures. Preserve the original `cause` when converting an external failure; do not cast an unknown rejection to `Error` or replace it with a success-shaped default.

### Catch the external call, not the whole workflow

Convert throwing external APIs at their call boundary: use `errore.try({ try: ..., catch: ... })` for synchronous calls and `.catch()` for asynchronous calls. App functions already return errors; do not catch the whole service operation.

A broad catch can disguise a parser bug as a file-read failure:

```ts
try {
  const raw = await fs.readFile(configPath, "utf8");
  return parseServerConfig(raw);
} catch (cause) {
  return new ConfigError({ detail: "read configuration", cause });
}
```

Prefer conversion at the actual I/O boundary:

```ts
const raw = await fs
  .readFile(configPath, "utf8")
  .catch((cause) => new ConfigError({ detail: "read configuration", cause }));
if (raw instanceof Error) return raw;
return parseServerConfig(raw);
```

The parser returns its expected validation errors. Unexpected bugs in it remain exceptions instead of being mislabeled as read failures.

Do not catch unexpected exceptions. Throw returned errors only at a protocol edge that requires it, and log errors intentionally not propagated.

### Release resources on every exit

Use `using` or `await using` with `errore.DisposableStack` or `errore.AsyncDisposableStack` instead of `try`/`finally` for cleanup. Register cleanup as resources are acquired so both success and failure release them.
