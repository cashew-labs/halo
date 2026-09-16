---
name: halo-app
description: Drive and test the running Halo Electron debug renderer with the development CLI, or inspect an extension in an isolated browser using the workspace CLI.
---

# Halo app and browser control

Use `pnpm halo-dev` from the repository root for development app control. Use `pnpm halo`, or the installed `halo` command inside a workspace, for workspace operations and private browsers. These are separate CLIs; neither builds, launches, restarts, or quits the app.

## Inspect Halo

```sh
pnpm halo status
pnpm halo-dev app snapshot
pnpm halo-dev app exec 'return await page.title()'
pnpm halo-dev app exec 'await page.getByRole("button", { name: "New session", exact: true }).click()'
pnpm halo-dev app screenshot
```

`pnpm halo-dev app` targets the Halo renderer, not DevTools. Electron main owns the app-control endpoint and exposes its debug port on `127.0.0.1:4445` in development. The workspace server does not host app control. Start the full stack with `pnpm dev` when the task calls for live testing. If only Electron is missing, start `pnpm --filter @get-halo/desktop dev` in a long-running terminal with the same `HALO_USER_DATA`.

For the root dev stack, set `HALO_USER_DATA="$PWD/tmp/workspace/.halo"` before the commands above. App commands read `HALO_APP_CONTROL_FILE` when set, otherwise `HALO_USER_DATA`, otherwise the nearest `.halo/appControl.json` above the current directory. They do not use `HALO_RPC_FILE` or product credentials. Production does not expose app control.

## Test an extension independently

```sh
halo browser open http://127.0.0.1:3000/view/
halo browser exec <id> 'await page.getByRole("textbox", { name: "Your name" }).fill("Ada")'
halo browser snapshot <id>
halo browser screenshot <id>
halo browser close <id>
```

Each `open` returns a browser ID, URL, title, accessibility tree, and runtime errors. It creates a private browser with isolated state; open the same extension twice to test collaboration. The page survives commands, while JavaScript variables do not. Each `exec` receives a live Playwright `page` and captures console output and accessibility changes. Use `return` to report a result. `halo browser list` finds existing sessions.

Prefer accessible names, labels, and roles. Wait for the visible effect of an action before inspecting it. For longer scripts, pass `--file checks.js` or `--stdin` to either target's `exec` command. App screenshots return a local PNG path under Electron's `<dataDir>/app/screenshots`; workspace browser screenshots use `<workspace>/.halo/browser/screenshots`. Read the returned file to inspect the layout.

Use private browser sessions for extension testing so the user's Halo navigation stays theirs. A hosted extension still shares its data through Tandem, so use a standalone preview with isolated data for test mutations. Close every browser opened for testing. The workspace server closes them when it stops; quitting Electron leaves them running.

Use `halo browser --help` and `pnpm halo-dev app --help` for command discovery. Output uses TOON by default; add `--json` when another command must parse it. Halo provisions Chromium once on first browser use; extensions do not need their own browser tooling installation.
