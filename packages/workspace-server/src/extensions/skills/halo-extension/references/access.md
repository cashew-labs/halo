# Access, inspect, and verify an extension

Read this reference whenever a task requires opening, observing, interacting with, debugging, or verifying an extension. Accessing an existing extension does not require rebuilding or changing it.

## Choose the access surface

Open a tab in the workspace Chrome with the `browser.*` tools for general access without changing the user's app navigation. `halo extension list` returns each running extension's direct view URL. The direct view uses the same hosted extension process, data, and connected tools as the view inside Halo.

Use a standalone preview when you need isolated data for layout work, local API behavior, routing, or write-heavy checks. Standalone tool calls return `halo_not_connected`, so this surface cannot access Halo tools or connected services.

## Access a running extension

List running extensions with `halo extension list`, then open the selected direct view URL from `exec`:

```js
var opened = await tools.browser.newPage({
  url: "http://127.0.0.1:<port>/view/",
});
if (!opened.ok) throw new Error(opened.error.message);
var tab = opened.data;
```

If a built extension is not running, `halo extension reload` discovers and starts it. Do not rebuild an extension merely to inspect its current hosted state.

`newPage` returns the tab ID, URL, and title. Each `tools.browser.call` runs one Playwright method on the page or on a locator chain and returns `{ value, url }`. The page keeps its state between calls:

```js
var call = async (chain, method, ...args) => {
  const result = await tools.browser.call({
    page: tab.id,
    chain,
    method,
    args,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.data.value;
};
await call([], "snapshot");
await call([["getByRole", ["button", { name: "Save" }]]], "click");
await call([["locator", ["body"]]], "innerText");
viewImage(await call([], "screenshot"));
await tools.browser.close({ page: tab.id });
```

Use accessible roles and labels to interact with the actual controls. `snapshot` returns refs such as `[ref=s1e2]`; act on one with the chain `[["locator", ["aria-ref=s1e2"]]]`. `screenshot` returns a PNG path that `viewImage` shows you when visual inspection matters. Check the page's own error states; a successful action does not prove that caught API or storage failures succeeded.

A hosted extension shares the user's extension records and connected services. Observe freely, but keep mutations within the user's requested task. The other tabs in this Chrome belong to the user: read them only when the task needs it, and do not act in them. Close every tab you open, including after failed checks; `tools.browser.tabs()` lists open tabs.

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

Halo owns the browser; extensions do not install Playwright.

## Verify behavior

Build success does not verify a rendered workflow. When verification is part of the task, exercise the requested controls, assert the visible result, and inspect runtime errors.

For synchronized records:

1. Open the standalone preview in two tabs with `newPage({ url, isolated: true })`. Isolated tabs do not share cookies or storage.
2. Create or edit a record in one browser.
3. Assert the rendered result appears in the other browser.
4. Confirm unfinished input and other React-local state did not synchronize.
5. Close both tabs, restart the preview, open a fresh isolated tab, and assert the committed record persisted.

Do not manipulate `tandem.json`, a legacy `store.json`, or the sync transport to prove these behaviors.

For hosted workflows, use the running direct URL from `halo extension list`. After a manual rebuild of a running extension, run `halo extension restart <id>` before accessing the new build. In development, `halo extension update <id>` rebuilds and restarts in one command.

Assert the actual integration result. For example, a calendar workflow must wait for a successful event request and render the returned events, or visibly establish that a successful response contained no events. A changing date heading alone does not establish calendar access.

Also exercise the visible failure path for an expected disconnected account or rejected request. Do not substitute sample data when the live request fails. If a connection or external dependency prevents the requested success path, report the task as incomplete and name the required user action.
