# Extension custom domains

Owners manage domains through `halo app domain add/list/verify/remove` or the
matching `apps.domains` API. Adding or verifying a domain requires a live,
publicly published app owned by the caller; listing and removal stay available
after unpublishing. Halo never edits a customer's DNS.

1. Add a hostname for the app. Publish the returned random `_halo-challenge`
   TXT record and routing A record.
2. Run `verify`. Halo checks the TXT value before creating any cloud resources.
3. Repeat `verify` to obtain the Google Certificate Manager authorization CNAME,
   then add it in DNS. Keep both verification and certificate DNS records.
4. Repeat `verify` until the returned status is `active`. This requires both a
   managed certificate and its load-balancer map entry to be ACTIVE.

An active custom host maps `/path?query` to the extension's `/http/path?query`,
with no browser redirect to a creator address. Only GET/HEAD pass through. Halo
forwards no browser cookies or bearer credentials, creates no viewer session,
strips response cookies, and uses public identity. Extension `http.ts` gets only
read-only storage queries. A redirect may target any absolute HTTP(S) URL; Halo
never fetches that destination. `/api`, `/sync`, and management stay on the
existing creator address. Each app has a shared 6,000 requests/minute limit and
10-second public-proxy timeout. Unknown hostnames cannot reach Halo RPC or WebSocket routes.

Removing a domain first disables routing, then deletes map entry, certificate,
and DNS authorization in that order. Cleanup is idempotent; repeat `remove` if
Google is still processing a deletion. App removal also removes domain resources.
Unpublishing or making the app private disables public routing immediately.
A hostname can have multiple pending challenges, but only one verified binding.
The SQL unique index enforces this across control-plane instances. Pending
claims do not squat a hostname. Each app can hold at most ten bindings.

Domain proof is checked on each explicit `verify`; it is not monitored in the
background. To transfer a hostname, publish the new app's TXT proof and remove
the old app's proof, then run `verify` for the new app. Halo disables the old
route and cleans up its certificate before assigning the new binding; retry
verification if cleanup is still pending. If both proofs remain in DNS, the
existing verified claim stays in place. Managed certificate renewal is handled
by Google.

## Deployment

Cloud Run configuration accepts `customDomains: { projectId, certificateMap,
address }`, supplied by `APP_DOMAIN_PROJECT_ID`, `APP_DOMAIN_CERTIFICATE_MAP`,
and `APP_DOMAIN_ADDRESS`. Pulumi supplies the shared global load-balancer IP and
certificate-map name and grants the runtime a custom role with certificate,
DNS-authorization and map-entry create/get/delete/use plus map-get/use and operation-get permissions.
It cannot update resources or create/delete certificate maps. These are
project-level permissions: the adapter restricts its requests to server-generated
`halo-domain-<UUID>` resources; IAM itself does not enforce that prefix.

Custom domains are disabled when no TLS provider is supplied. Local/test hosts
inject DNS and certificate drivers into `ControlPlane.start`; no cloud or DNS
mutation is required for automated verification. Tests control external provider
responses at their HTTP boundary. Live certificate issuance and IAM must still
be checked in staging after deployment with working GCP credentials.

For `go.gethalo.dev`, use the production routing address and register the
marketing app through the same owner/proof flow. `go` is reserved as a creator
handle. DNS alone does not bind a hostname to an app or activate its HTTPS.

Provider API references:

- https://docs.cloud.google.com/certificate-manager/docs/dns-authorizations
- https://docs.cloud.google.com/certificate-manager/docs/reference/certificate-manager/rest/v1/projects.locations.certificates/create
- https://docs.cloud.google.com/certificate-manager/docs/reference/certificate-manager/rest/v1/projects.locations.certificateMaps.certificateMapEntries/create
