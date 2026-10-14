# Sharing an extension as an app

Publishing moves an extension to its own app VM. Its link is `https://<handle>.gethalo.dev/<slug>/`; all of one creator's apps share that host, so treat them as one browser trust boundary. The app VM then holds the only source, build and data. The local directory is retired to `.halo/published-backups/<appId>/`, and Halo keeps a link to the live app. Visitors and the owner use the same live app.

## Declare the app before publishing

Declare the app in `package.json` under `halo.app`. Without a declaration, visitors can read synced records and nothing else.

```json
{
  "halo": {
    "displayName": "Reading list",
    "app": {
      "description": "Books I am reading",
      "sync": "read-only",
      "actions": []
    }
  }
}
```

- `sync` sets what visitors may do over Tandem. `read-only` lets them pull records. `shared` lets them push records too. `actions` blocks visitor sync, so all reads and writes go through API handlers, which see `context.viewer`.
- `actions` lists fixed integration requests. Each action names one connected tool by `address` and gives every argument in `arguments`. Resolve resource names to real IDs with the owner's connection first, for example a Notion database ID. Visitors cannot change a fixed argument. Add `sampleResult` to show demo data later.

## Call actions from app code

A published app's API handlers reach integrations only through its declared actions:

```ts
const result = await context.tools.actions.addPage({});
if (!result.ok) return { error: result.error.message };
```

Pass no arguments, or exactly the fixed ones. A different value fails with `invalid_action`, and other tools such as `context.tools.files` or `context.tools.integrations` are unavailable. Each app shares a limit of 120 action calls every 10 minutes across all visitors.

Handlers see who is calling in `context.viewer`. `role` is `owner`, `member` (an invited Halo account, with `email`), or `public` (a pseudonymous visitor ID, with no email).

## Publish and edit

```sh
halo app publish my-extension                     # anyone with the link
halo app publish my-extension --invite a@example.com
halo app list                                     # links, access and app IDs
halo app unpublish <appId>                        # stop sharing; it keeps running for you
```

The extension stops locally while it is copied. If publishing fails, `halo app list` shows the app as `publishing`. Run the same `halo app publish` again to finish, or run `halo app cancel <appId>` to restart the local extension. Cancel works only before the copy reaches the app VM; after that, publishing again finishes the move.

After publishing, edit the app on its VM, not in `.halo/extensions/`:

```sh
halo app read <appId> view.tsx
halo app write <appId> view.tsx --file ./view.tsx
halo app exec <appId> "npm run build"             # build sandbox: source only, no app data
halo app restart <appId>
halo app bind-actions <appId> --file actions.json # replace fixed requests
```

`exec` runs in a container that can write source but cannot read app data or Halo credentials. The public backend runs read-only code in a separate sandbox.
