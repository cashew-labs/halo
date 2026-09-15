---
name: halo-app
description: Drive and test the running Halo Electron debug renderer, or inspect an extension in an isolated browser using the Halo CLI.
---

# Halo app and browser control

Use `pnpm halo` from the repository root, or the installed `halo` command from a workspace. The CLI connects to the running Halo server. It does not build, launch, restart, or quit the app.

## Inspect Halo

```sh
pnpm halo status
pnpm halo app snapshot
pnpm halo app exec 'return await page.title()'
pnpm halo app exec 'await page.getByRole("button", { name: "New session", exact: true }).click()'
pnpm halo app screenshot
```

`halo app` targets the Halo renderer, not DevTools. It requires a development build with its debug port on `127.0.0.1:4445`. If the app is not running and the task calls for live testing, start `pnpm --filter @get-halo/desktop dev` in a long-running terminal.

## Test an extension independently

```sh
halo browser open http://127.0.0.1:3000/view/
halo browser exec <id> 'await page.getByRole("textbox", { name: "Your name" }).fill("Ada")'
halo browser snapshot <id>
halo browser screenshot <id>
halo browser close <id>
```

Each `open` returns a browser ID, URL, title, accessibility tree, and runtime errors. It creates a private browser with isolated state; open the same extension twice to test collaboration. The page survives commands, while JavaScript variables do not. Each `exec` receives a live Playwright `page` and captures console output and accessibility changes. Use `return` to report a result. `halo browser list` finds existing sessions.

Prefer accessible names, labels, and roles. Wait for the visible effect of an action before inspecting it. For longer scripts, pass `--file checks.js` or `--stdin` to either target's `exec` command. Screenshots return a workspace PNG path; read that file to inspect the actual layout.

Use private browser sessions for extension testing so the user's Halo navigation stays theirs. A hosted extension still shares its data through Tandem, so use a standalone preview with isolated data for test mutations. Close every browser opened for testing. Halo also closes them when the workspace changes or the app quits.

Use `halo browser --help` and `halo app --help` for command discovery. Output uses TOON by default; add `--json` when another command must parse it. Halo provisions Chromium once on first browser use; extensions do not need their own browser tooling installation.
