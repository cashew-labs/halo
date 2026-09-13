# Verify an extension

Build success does not verify the rendered workflow. Exercise controls through the browser, assert the requested result, inspect runtime errors, and close every browser session you open.

## Choose the server

Use a standalone preview for layout, local API behavior, routing, and extension-owned Tandem records. It provides isolated data and is safe for write tests.

Use the Halo-hosted URL for workspace tools and connected services. Standalone tool calls return `halo_not_connected`, so a standalone preview cannot validate integration behavior. Mutations against a hosted extension affect the user's shared extension data and connected services; keep them within the requested task.

## Standalone preview

After `npm run typecheck` and `npm run build`, start the selected build in the background from the extension directory:

```sh
node dist/start.mjs --port 0 --data-dir .extension-data > .extension-preview.log 2>&1 < /dev/null & echo $!
```

Save the PID. Read `.extension-preview.log` for the printed `/view/` URL. After source changes, rebuild and restart the preview so it loads the new generation.

An interactive human can instead run:

```sh
npm start -- --port 0 --data-dir .extension-data
```

Stop a background preview with `kill <saved-pid>` when finished.

## Private browser sessions

Halo owns the browser runtime; extensions do not install Playwright:

```sh
halo browser open http://127.0.0.1:<port>/view/
halo browser exec <id> 'await page.getByRole("textbox").fill("Milk"); await page.getByRole("button", { name: "Add" }).click();'
halo browser snapshot <id>
halo browser screenshot <id>
halo browser close <id>
```

`open` returns the browser ID, URL, title, accessibility tree, and runtime errors. State in the page survives later CLI calls, but JavaScript variables do not. Every `exec` receives a live Playwright `page`; use `await` for actions and `return` to inspect a value.

Use accessible roles and labels to drive actual controls. Read the PNG path returned by `screenshot` with the workspace file tools when visual inspection matters. `snapshot` reports runtime errors, but `errors: []` does not prove that caught API or storage failures succeeded.

Keep reusable workflow assertions in a script inside the extension:

```sh
halo browser exec <id> --file checks.js
```

`--stdin` is also supported. Use `halo browser list` to find sessions and close all of them, including after failed checks.

Do not use `halo app` commands for routine extension testing; those commands deliberately operate the user's Halo renderer. Use `halo browser` to inspect a hosted extension URL without changing the user's app navigation.

## Tandem checks

For synchronized records:

1. Open the standalone preview in two independent browsers.
2. Create or edit a record in one browser.
3. Assert the rendered result appears in the other browser.
4. Confirm unfinished input and other React-local state did not synchronize.
5. Close both browsers, restart the preview, open a fresh browser, and assert the committed record persisted.

Do not manipulate `store.json` or recreate the sync transport to prove these behaviors.

## Hosted workflow checks

After `halo extension reload`, obtain the running extension URL from Halo and open that URL in a private browser. A new extension starts immediately; rebuilding an already running extension requires a workspace-server restart before the hosted process uses the new build.

Assert the actual integration result. For example, a calendar workflow must wait for a successful event request and render the returned events, or visibly establish that a successful response contained no events. A changing date heading alone does not verify calendar access.

Also exercise the visible failure path for an expected disconnected account or rejected request. Do not substitute sample data when the live request fails. If a connection or external dependency prevents the requested success path, report the task as incomplete and name the required user action.
