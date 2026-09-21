# Testing

Start with what a consumer can do, drive that behavior through the package's public surface, and check the result they can observe.

Do not write tests unless you are updating existing tests, adding coverage to an existing test file, or the user asks for them. When changing tests, extend the existing canonical test file and fixture where they fit.

## Choose the consumer boundary

Package tests are E2Es through the main supported exports. Apps use their public UI or protocol. The consumer boundary defines E2E, not the number of processes: an exported reducer can be tested directly. Use Vitest for library/server APIs and Playwright for UI workflows.

For an exported reducer, that means testing `applySessionEvent(emptySessionSnapshot(), event)` through the client package's root export. Do not start a server just to call it, or import a private module and relabel the test as a package E2E.

## Locate and name tests by boundary

Put package E2Es under `path/to/package/test/` and name them `*.spec.ts`. Import the package's main export and use that public surface as the fixture API; do not reach into source files from an E2E.

Put unit tests beside their source and name them after the file's main export: `<MainExport>.test.ts`. Name source-local fixtures and other test-only helpers `*.test.ts` too, so production source discovery cannot mistake them for runtime modules. Explicitly exclude support-only `*.test.ts` files from test discovery; never add placeholder tests to make Vitest accept them. A unit test is a convenient in-package pseudo-E2E for that export. Exercise the same consumer-facing API that another module would use, and do not test private state, helper calls, or implementation details. Use a package E2E instead when the behavior belongs to the package contract rather than one file's cohesive API.

Apply this layout to new or currently changed tests. Do not expand a focused task into renaming unrelated legacy tests.

## Build one realistic setup

Use one canonical setup form per package, with one shared fixture and test entry where runtime setup is needed. Pure API tests need no artificial fixture. Feature files and setup helpers can remain separate, but must compose behind that fixture rather than export alternate fixtures or mount internal subsets.

Always implement test fixtures with Vitest or Playwright's native fixture API. If a fixture is used by multiple test files, consolidate it in `fixtures.ts` under an E2E `test/` directory or `fixtures.test.ts` beside production source. If it belongs to one test file, define it near the top of that file. Name the extended test for the fixture it provides, such as `databaseTest`. Test filenames follow the consumer boundary rules above rather than the fixture name. Do not approximate fixture lifecycle with setup helpers and `onTestFinished`.

Control-plane auth, routing, proxying, and lifecycle scenarios use the complete `controlPlane` fixture. Existing alternate fixtures are migration work, not examples to copy. For example:

```ts
// Avoid: an auth-only fixture bypasses the control plane.
authServiceTest("starts sign-in", async ({ auth }) => {
  const response = await auth.handle(signInRequest);
  expect(response.status).toBe(200);
});

// Prefer: the canonical fixture handles a public request.
test("starts sign-in", async ({ controlPlane }) => {
  const response = await fetch(
    `${controlPlane.origin}/api/auth/sign-in/social`,
    signInOptions,
  );
  expect(response.status).toBe(200);
});
```

Use the real package and its local dependencies. A frontend that needs a server starts and connects to it. Control unavailable external systems, such as OAuth or inference, at their host boundary; do not mock internal services.

Expose the consumer API and relevant external drivers, such as a second client or provider server. Add drivers for tested behavior, not hypothetical needs. Prepare specific states through semantic test operations rather than writing internal database records. A runtime-gated `testApi` on the normal client contract is a valid setup surface: enable it explicitly for tests, keep it disabled in normal use, and assert results through the ordinary consumer API or UI. Do not add separate hosts, clients, or transports merely to distinguish test setup.

## Assert what the consumer experiences

Write clear setup → action → assertion workflows. Prefer successful behavior; test errors real consumers may encounter. Give each test distinct coverage and preserve that coverage when moving fixtures.

Assert end-user state, not calls between internal services or private database rows. Avoid historical assertions about removed APIs or failures caused by incomplete setup.

### A file can be a consumer-visible result

For a screenshot command, the saved image is part of the consumer's experience. Given an open browser and the package fixture:

```ts
// Avoid: a call proves wiring, not that a usable image was saved.
await server.rpc.browser.screenshot({ id });
expect(screenshotSpy).toHaveBeenCalled();

// Prefer: the consumer can read the saved PNG.
const image = await server.rpc.browser.screenshot({ id });
const bytes = await server.harness.files.read(image.path);
expect(bytes.subarray(0, 8)).toEqual(
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
);
```

This applies when consumers access files directly. An internal database file does not make private rows a valid assertion surface.

## Keep unit tests at the file boundary

Unit-test a file when its main export has a cohesive consumer contract, such as a service or data structure. Test that export as a consumer would. Do not expose internals solely for tests. If the contract grows across files or another package needs it, extract it; its tests become package E2Es through the extracted package's main export.
