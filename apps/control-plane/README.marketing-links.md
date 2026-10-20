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

Use Halo's normal primary origin, `https://staging.gethalo.dev/rpc` for this staging-backed deployment, for management.
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
curl --fail-with-body https://staging.gethalo.dev/rpc/marketing/create \
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

## Staging management, production destinations

The `west` stack stores live campaigns in staging's `marketing_links` table.
Set `halo-control-plane:marketingHostname: go.gethalo.dev` and
`halo-control-plane:marketingHomepageOrigin: https://gethalo.dev` (already in
`Pulumi.west.yaml`). Direct deployments use `HALO_MARKETING_HOSTNAME` and
`HALO_MARKETING_HOMEPAGE_ORIGIN`. Defaults remain `go.<primary-host>` and the
primary homepage when these overrides are absent.

Sign in through `staging.gethalo.dev` and configure your **staging** account ID in
`west`'s administrator list. Its workspace runtime can then manage live campaign
links without a production session. Staging's primary origin and authentication
stay unchanged. The production database and administrator list are separate and
do not control these links. Staging outages, database resets and campaign edits
affect live marketing URLs, so preserve staging campaign data.

## Rollout

Deploy the complete server stack before creating campaigns. Every public lookup
reads the enabled campaign directly from the database, so creation, edits,
disabling and deletion take effect without restarting the service. PostgreSQL
replicas share the same table; there is no process-local campaign cache. Local
development uses the existing control-plane SQLite app database file.

Production's former configuration map was empty, so no campaign import is
required. Remove `HALO_MARKETING_LINKS` and `halo-control-plane:marketingLinks`;
these are no longer a source of campaign data. Keep administrator IDs and hostname/homepage settings in deployment configuration.
The custom marketing hostname gets a dedicated load-balancer-authorized Google
certificate on staging's existing certificate map; its wildcard certificate does
not cover `go.gethalo.dev`. Deploy the server image and infrastructure first.
Then replace the existing Vercel `go` routing records with this record:

| Type | Name | Value          | TTL |
| ---- | ---- | -------------- | --- |
| A    | `go` | `34.54.19.173` | 60  |

This is staging's reserved load-balancer IP, confirmed by the `west` preview and
`controlPlaneDomainIp` output. No extra certificate-verification CNAME is needed
for load-balancer authorization. Certificate issuance starts after DNS reaches
this load balancer; wait for the certificate to become active, then create and
check a campaign before sharing links. See [the infrastructure guide](../../infra/README.md).
The existing production landing page handles Google Analytics and waitlist/booking
attribution after the redirect. No deployment or DNS changes are performed by this PR.
