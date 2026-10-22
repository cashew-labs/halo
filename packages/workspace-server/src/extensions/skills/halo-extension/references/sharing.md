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
      "actions": [],
      "instructions": "Recommend books from the list."
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

## Add an assistant

Every published app can hold assistant conversations with its visitors. `instructions` in `halo.app` tells that assistant what the app is for. A handler starts or continues a visitor's conversation:

```ts
chat: os
  .input(type<{ message: string; conversationId?: string }>())
  .handler(async ({ input, context }) => {
    // Only requests that come through Halo carry a viewer token.
    if (context.viewer.token === undefined) throw new Error("Open this app in Halo");
    return await context.tools.conversation.send({
      viewerToken: context.viewer.token,
      message: input.message,
      // Omit conversationId to start a new conversation.
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    });
  }),
```

`send` returns `{ conversationId, reply }`; `conversation.history({ viewerToken, conversationId })` returns the visible messages. A conversation belongs to the viewer whose request carried the token, so another visitor cannot read it. The assistant can call only the app's bound actions, gets at most 4 model steps and 1024 output tokens per message, and conversations never appear in your Halo threads. Each app shares 1,000 model requests every 10 minutes across all visitors.

## Publish and edit

```sh
halo app publish my-extension                     # anyone with the link
halo app publish my-extension --invite a@example.com
halo app list                                     # links, access and app IDs
halo app unpublish <appId>                        # stop sharing; it keeps running for you
halo app remove <appId>                           # remove its VM; keep the latest extension locally
halo extension delete <extensionId>               # delete the local extension and its data
```

Each command has one purpose. `unpublish` stops sharing and keeps the app VM running privately. `app remove` requires an unpublished, fully published app: it stops the hosted extension, saves its latest source, build and data in the workspace, removes the VM and app record, then restores the local extension. It keeps the publication backup and leaves the extension stopped. Run `halo extension reload` to start it locally if you want to keep using it. `extension delete` stops and deletes the local extension, its data and associated publication backups; remove its hosted app first. None of these commands asks for confirmation.

To fully delete a published app, run the three commands above in order. Retry `halo app remove <appId>` if removal is interrupted; the app cannot be shared again once removal starts. Published templates and their separate demos remain available.

The extension stops locally while it is copied. If publishing fails, `halo app list` shows the app as `publishing`. Run the same `halo app publish` again to finish, or run `halo app cancel <appId>` to restart the local extension. Cancel works only before the copy reaches the app VM; after that, publishing again finishes the move.

After publishing, edit the app on its VM, not in `.halo/extensions/`:

```sh
halo app read <appId> view.tsx
halo app write <appId> view.tsx --file ./view.tsx
halo app exec <appId> "npm install --no-audit --no-fund && npm run build"  # build sandbox: source only, no app data
halo app restart <appId>
halo app bind-actions <appId> --file actions.json # replace fixed requests
```

`exec` runs in a container that can write source but cannot read app data or Halo credentials. Published source has no `node_modules`, so install dependencies before the first build. The public backend runs read-only code in a separate sandbox.

## Publish a template

A template lets others try the app with sample data and install their own copy. First add `sample-data.json` to the app's source: a copy of the app's `tandem.json` holding only made-up records. Then publish:

```sh
halo app write <appId> sample-data.json --file ./sample-data.json
halo app template <appId> --slug reading-list --description "Track what you read"
```

The listing is `https://gethalo.dev/templates/<slug>` and the demo is `https://<handle>.gethalo.dev/demo-<slug>/`. Each demo visitor gets a separate copy that starts from the sample data and is discarded later. In the demo, actions return their `sampleResult` and the assistant is off. A template never includes live data, and fixed action arguments are removed.

Installing a template creates a private app for the installer on its own VM, rebuilt in the build sandbox, with no actions bound. The installer's agent binds their own resources with `halo app bind-actions`.
