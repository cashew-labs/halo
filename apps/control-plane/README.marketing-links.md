# Marketing link administration

Marketing campaigns live in Halo's control-plane database. Each link maps a slug
to the Halo homepage with saved UTM tags; it cannot choose another destination.
There is no management UI or extension. Public visitors need no authentication.

## Grant administrator access

Configure `halo-control-plane:marketingAdminUserIds` as an array of existing Halo
account IDs, or supply `HALO_MARKETING_ADMIN_USER_IDS` as a JSON array for a direct
server deployment. Deployment controls this list; callers cannot grant themselves
access. It defaults to `[]`, denying all management operations. The ordinary
sign-in allowlist, publisher ownership and extension membership do not grant
marketing administrator access.

Find your account ID through the existing authenticated `auth.session` RPC. Use
`session.user.id`, not the session ID. Configure the administrator list and deploy
once. Changing campaign links then requires no deployment. Restart all replicas
when changing the administrator list so revocations apply to every process.

## Agent API

Use Halo's normal primary origin, such as `https://gethalo.dev/rpc`, for management.
`go.gethalo.dev` only resolves public links. Authenticate with an existing desktop
bearer session or with the existing workspace runtime bearer token belonging to a
configured administrator. A runtime authenticates its server-recorded owner;
submitting an owner ID cannot impersonate an administrator. App VM tokens and
ordinary users are rejected.

Browser sessions must send Halo's exact primary `Origin`. Cookie-only requests
without an Origin and requests from other origins are rejected. Agents should use
explicit bearer authentication. Keep credentials out of campaign URLs and logs.

With the existing `ControlPlaneClient` and its normal RPC transport:

```ts
const tags = {
  utm_source: "linkedin",
  utm_medium: "social",
  utm_campaign: "launch",
};
await client.marketing.create({ slug: "linkedin-launch", tags });
await client.marketing.list(); // includes enabled and disabled campaigns
await client.marketing.update({
  slug: "linkedin-launch",
  tags: { ...tags, utm_content: "founder-post" },
  enabled: true,
});
await client.marketing.update({
  slug: "linkedin-launch",
  tags,
  enabled: false,
});
await client.marketing.remove({ slug: "linkedin-launch" });
```

The same API is available to HTTP clients. This example assumes the agent already
has its owner's authorized token in `HALO_TOKEN`:

```sh
curl --fail-with-body https://gethalo.dev/rpc/marketing/create \
  -H "Authorization: Bearer $HALO_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'x-halo-protocol-version: 6' \
  --data '{"json":{"slug":"linkedin-launch","tags":{"utm_source":"linkedin","utm_medium":"social","utm_campaign":"launch"}}}'
```

Use POST with a `{ "json": ... }` body for `create`, `update` and `remove`. `list`
accepts POST without input. RPC responses wrap the result in `json`. Creation
starts enabled. Updates replace all tags and enabled state; omitting optional
content/term removes them. Slugs are 1–63 lowercase letters, digits or hyphens,
starting with a letter or digit. UTM source, medium and campaign are required;
content and term are optional. Each tag must contain a non-whitespace character
and be at most 512 characters. Unknown fields, including destination URLs and
caller-supplied owner IDs, are rejected.

Duplicate slugs return `CONFLICT`; updating/removing a missing slug returns
`NOT_FOUND`. Insufficient admin authority returns `FORBIDDEN`. Database failures
return an internal error rather than pretending a campaign was missing or saved.
Deleting allows reuse of that slug; disabling preserves it and is reversible.

## Rollout

Deploy the complete server stack before creating campaigns. Every public lookup
reads the enabled campaign directly from the database, so creation, edits,
disabling and deletion take effect without restarting the service. PostgreSQL
replicas share the same table; there is no process-local campaign cache. Local
development uses the existing control-plane SQLite app database file.

Production's former configuration map was empty, so no campaign import is
required. Remove `HALO_MARKETING_LINKS` and `halo-control-plane:marketingLinks`;
these are no longer a source of campaign data. Keep only the administrator list
in deployment configuration.
Use the existing #554 marketing ingress and wildcard certificate setup. This
feature does not require the extension custom-domain or dynamic TLS system.
Verify hostname routing and certificate activation on staging before sharing
production links. The existing landing page handles Google Analytics and
waitlist/booking attribution after the redirect.
