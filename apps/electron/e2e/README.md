# Electron end-to-end tests

The Electron E2E suite packages Halo once, then launches a fresh app with an isolated workspace and user-data directory for every test.

The `app` fixture opens automatically. Drive the current renderer through `app.page` and the app's public server through `app.server.rpc`. To test an Electron restart, quit and reopen the same app:

```ts
e2eTest("keeps saved data after reopening", async ({ app }) => {
  // Save through the running app, then restart the whole Electron process.
  await app.quit();
  await app.open();
  await expect(app.page.getByRole("main")).toBeVisible();
});
```

`quit()` closes Electron and its windows. The independently launched workspace server remains running until fixture teardown. `open()` launches a fresh process using the same test workspace and user-data directory. Read `app.page` and `app.server` again after reopening; saved pages and locators belong to the previous Electron launch. The separate `server` fixture owns a normal RPC client that remains available while Electron is closed. Harness tool helpers use `server.rpc.testApi`; `harness.loadSession` also reloads and selects the session in the UI, so it requires an open app. Teardown quits any remaining app, including when the test has already quit it. If setup must happen while Halo is closed, use `server.rpc.testApi` or the harness file/tool helpers before `app.open()`.

The ordinary `e2eTest` fixture uses `LLMDriver` from `@get-halo/workspace-server/testing`, shared with the server suite, to own a scripted OpenAI-compatible HTTP endpoint on a random loopback port. The fixture launches `apps/workspace-server/src/main.ts` under Node with the workspace launch configuration and passes the model endpoint through `HALO_LLM_CONFIG`. The entry point constructs the HTTP-backed `LLMApi` and starts `WorkspaceServer` directly. Test mode enables its runtime-gated `testApi` namespace on the same authenticated RPC connection. There is no separate test listener or token. Both the inference endpoint and workspace process stay running across app restarts. Electron has no LLM test event handlers.

Import `m` from `@get-halo/shared/testing`; server and Electron tests share this response vocabulary. Responses follow the timeline of the test:

```ts
e2eTest("answers a message", async ({ app, llm }) => {
  await app.page.getByRole("button", { name: "New session" }).click();
  await app.page.getByLabel("Message", { exact: true }).fill("Hello");
  await app.page.getByRole("button", { name: "Send", exact: true }).click();

  await llm.respond(m.assistant("Hello back."));

  await expect(app.page.getByRole("main")).toContainText("Hello back.");
});
```

`respond()` answers one pending inference request, waiting up to ten seconds if it has not arrived. It releases the scripted response; use UI assertions to wait for Halo to process it. Stopping a run cancels its pending inference request. Closing Electron leaves the request running; reopening reconnects to the same server session.

Use `m.assistant(...)`, `m.tool.start(...)`, or an array combining text and tool calls. Tool results come from Halo's real tool execution; `m.tool.end(...)` and the seeded-history helpers that include fabricated results are not accepted. `m.error("Model access denied")` returns HTTP 403 with an OpenAI-shaped error body. Successful replies use Chat Completions server-sent events, including tool-call deltas and a finish reason.

Use static replies unless the response needs to depend on the request. A response callback receives the actual OpenAI Chat Completions request and can return a description asynchronously. This is the same callback format used by server tests; `messageText` from `@get-halo/workspace-server/testing` extracts text from its messages. For history coverage, derive an answer from those messages and assert the visible reply. Message content may be text or content parts; tool results have role `tool`. Avoid request snapshots, call-count assertions, or answers that contain the expected history regardless of what Halo sends.

These tests exercise the real Pi agent loop, tools, and persistence through Pi's real HTTP inference client and a scripted endpoint. They do not verify local Pi authentication, a commercial provider, or a future control-plane transport. The restart scenario in `sessionView.e2e.test.ts` creates its history through actual prompts and tool execution, then proves that restored messages and tool results support the next answer. Separate scenarios cover stopping or quitting during a pending response, and preserving the submitted message while recovering from an inference error.

Extension tests use the canonical `e2eTest` fixture and request
`loadExtension("./fixtures/name")`. Its worker-scoped package fixture builds and
packs the SDK and tools lazily, then the test-scoped helper scaffolds an
independent extension package, installs those packages, typechecks and builds
the extension, and reloads Halo. Extension source is checked against its
installed dependencies, separately from the harness TypeScript project. Tests
that do not request extension helpers do not build the extension packages.

`extensionTools.e2e.test.ts` loads a real trusted extension and clicks Refresh notes to display a workspace file through `context.tools.files.read`, with no approval step. Its source declares the types of the tool it consumes. A separate scenario verifies that the tool bridge works after restarting Halo. These cover a real workspace tool; they do not establish OAuth or external-service behavior.

Use `harness.tools.files.read({ path })` and `harness.tools.files.write({ path, content })` to author workspace files. These calls reach the running app's real tool runtime through the E2E-only RPC bridge. The runtime checks agent authority, validates tool inputs, resolves workspace paths, and invokes the registered production file tool. The harness has no filesystem implementation or separate runtime.

The bridge returns successful tool data directly (`read` returns `{ path, text }`) and rejects failed calls through RPC. The typed harness surface currently exposes file reads and writes; their input/output types come from the production implementations. The bridge is disabled outside E2E runs.

Scenario actions use product services directly. Harness helpers may organize observations and assertions; fixtures own environmental setup and cleanup. Do not add a parallel files API or a harness server for product artifacts.

`app.openWindow()` opens another real renderer connected to the same server. The Electron fixture owns all windows and closes them when the app quits; the artifact fixture captures their console output and the Playwright trace.

`app.server.rpc.browser` is the same workspace browser API used by `halo browser`. Tests open a browser through that API and drive it through `exec`; Halo owns its lifecycle and closes it when the workspace server stops. The fixture does not serve assets or fabricate responses.

The suite uses Playwright's default worker count: half the logical CPU cores, each with its own server, workspace, and Electron app. Pass `--workers=1` to run serially when you want lower resource usage.

The app fixture has a separate 60-second setup and teardown timeout, so concurrent process startup does not consume the test's 30-second action budget.

Run the suite:

```sh
pnpm --filter @get-halo/desktop test:e2e
```

Show the Electron window while the tests run:

```sh
HALO_E2E_HEADFUL=1 pnpm --filter @get-halo/desktop test:e2e
```

Open Playwright Inspector and show the Electron window:

```sh
PWDEBUG=1 pnpm --filter @get-halo/desktop test:e2e
```

Passing tests remove their temporary files. Failed tests, including expected failures, retain their workspace, Electron user data, Halo JSONL logs, renderer console log, and each launch's main-process output, screenshot, and Playwright trace under `tmp/e2e/`. Files use `launch-1`, `launch-2`, etc. so reopening preserves earlier diagnostics. The test output prints the exact retained directory.

Open a retained trace with:

```sh
pnpm --filter @get-halo/desktop exec playwright show-trace tmp/e2e/<test-directory>/launch-1.trace.zip
```
