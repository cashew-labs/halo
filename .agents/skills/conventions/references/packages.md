# Packages

A package gives consumers a cohesive API. Its boundary should explain what they can use without making them understand how the code is organized inside.

## Decide whether a new package earns its place

Create packages for cohesive consumer contracts. Do not extract a package just to share a few lines or make an internal test qualify as an E2E. Use libraries such as Playwright and `libretto-browser-tools` directly when they already supply the needed abstraction.

For example, a browser wrapper that only forwards commands adds no independent contract:

```ts
// Avoid: a separate package that only forwards a library call.
export function createBrowserPage(page: Page) {
  return createBrowserToolsForPage(page);
}

// Prefer: the owning service uses the library directly.
const toolkit = createBrowserToolsForPage(page);
```

The service still owns page lifetime, permissions, error conversion, and where screenshots are saved. Using the library directly does not remove that ownership.

## Put it in the right layer

Use pnpm workspaces and Turborepo. Keep deployable hosts in `apps/`, reusable services and UI in `packages/`, and deployment configuration in `infra/`. Apps compose packages; reusable packages do not import app internals. Keep dependencies acyclic.

## Expose the contract, not the file tree

Each package has one supported main entry, not necessarily one exported symbol. Consumers import that public API rather than internal files. Document runtime-separated export exceptions when combining browser and server code would load incompatible dependencies.

Inside the package, organize files around service ownership. Keep a service, its helpers, and its types together, such as `auth/AuthService.ts` and `auth/callback.ts`. Put shared children at the lowest common owner that needs them. Split by responsibility, not file length.
