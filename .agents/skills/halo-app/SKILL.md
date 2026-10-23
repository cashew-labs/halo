---
name: halo-app
description: Drive and test the running Halo Electron debug renderer with the development CLI, or inspect an extension in an isolated browser.
---

# Halo app and browser control

Use `pnpm halo-dev` from the repository root for development app control. Use `pnpm halo`, or the installed `halo` command inside a workspace, for workspace operations. These are separate CLIs; neither builds, launches, restarts, or quits the app.

## Inspect Halo

```sh
pnpm halo status
pnpm halo-dev app snapshot
pnpm halo-dev app exec 'return await page.title()'
pnpm halo-dev app exec 'await page.getByRole("button", { name: "New thread", exact: true }).click()'
pnpm halo-dev app screenshot
```

`pnpm halo-dev app` targets the Halo renderer, not DevTools. Electron main owns the app-control endpoint and exposes its debug port on `127.0.0.1:4445` in development. The workspace server does not host app control. Start the full stack with `pnpm dev` when the task calls for live testing. If only Electron is missing, start `pnpm --filter @get-halo/desktop dev` in a long-running terminal with the same `HALO_USER_DATA`.

The root `pnpm halo-dev` and `pnpm halo` scripts set `HALO_USER_DATA` to `<repo>/tmp/workspace/.halo`, matching `pnpm dev`. App commands read `HALO_APP_CONTROL_FILE` when set, otherwise `HALO_USER_DATA`, otherwise the nearest `.halo/appControl.json` above the current directory. They do not use `HALO_RPC_FILE` or product credentials. Production does not expose app control. Set `HALO_USER_DATA` or `HALO_APP_CONTROL_FILE` when launching Electron yourself with a different data directory.

## Test an extension independently

Open the extension's loopback URL, such as `http://127.0.0.1:3000/view/`, in your own Playwright Chromium or `agent-browser` session. Use a separate browser context for each simulated user; open the same extension in two contexts to test collaboration. The `halo browser` CLI was removed: agents inside a Halo session drive the workspace Chrome through `tools.browser` in `exec` instead.

Prefer accessible names, labels, and roles. Wait for the visible effect of an action before inspecting it. App screenshots return a local PNG path under Electron's `<dataDir>/app/screenshots`; read the returned file to inspect the layout.

A hosted extension still shares its data through Tandem, so use a standalone preview with isolated data for test mutations. Close every browser you open for testing.

Use `pnpm halo-dev app --help` for command discovery. Output uses TOON by default; add `--json` when another command must parse it.
