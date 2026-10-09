# Halo infrastructure

Halo production runs in GCP project `halo-relay` with the control plane in
`us-west2` and user workspace VMs in `us-west2-a`. The active Pulumi
control-plane stack is `west`.

The Pulumi state bucket and KMS key remain in `us-central1`. They are bootstrap
resources outside the application stacks and are not on the application request
path. Do not delete or move the KMS key: the active `west` stack uses it to
decrypt Pulumi secrets.

The production control-plane origin is `https://gethalo.dev`, configured through
`controlPlaneDomain`. A global HTTPS load balancer routes to Cloud Run; HTTP
redirects to HTTPS and `www.gethalo.dev` redirects to the apex hostname. Vercel
remains the registrar and authoritative DNS provider. Production Electron
builds use the custom origin, while the Cloud Run default URL remains reachable
for previously released desktop clients.

## Staging and production stacks

The `control-plane/` program has two stacks in `halo-relay`. Each has its own
control plane, Cloud SQL database, load balancer, secrets, and exe.dev VM tag
(`halo-<stack>`). They share the exe.dev account, the Together API key, the
Google OAuth clients, and release images.

| Stack  | Role       | Origin                        | Images                                             |
| ------ | ---------- | ----------------------------- | -------------------------------------------------- |
| `west` | Staging    | `https://staging.gethalo.dev` | Builds into `halo-west-workspaces`                 |
| `prod` | Production | `https://gethalo.dev`         | Reads `halo-west-workspaces` (`imageRepositoryId`) |

`west` keeps its name because every resource name derives from the stack name.
`prod` sets these options to share `west`'s resources:

- `imageRepositoryId` reads release images from `west`'s repository and skips
  creating a repository, build-source bucket, and builder, so release images
  are built once and deployed to both stacks.
- `googleClientIdSecretId` and `googleClientSecretId` reuse the
  `halo-west-control-plane-google-client-*` sign-in client.
- `ownsDeploymentAccess: false` leaves the project-wide grants to the deployment
  service account (logging config, Pub/Sub admin, OS Login, IAP, and the exe.dev
  key) to `west`. Do not destroy `west` without first moving that ownership.
- Without `exeGatewaySecretId`, the stack generates `halo-<stack>-exe-gateway-seed`.

Set `redirectWww: false` for a subdomain origin; apex origins also serve and
redirect `www`.

Until the cutover moves `west` to `staging.gethalo.dev`, `west` still serves
`gethalo.dev` and `prod` is not deployed.

## Production layout

- `control-plane/` owns the `halo-west` network, Cloud NAT, Artifact Registry,
  build-source bucket, Cloud SQL database, runtime secrets, service accounts,
  Cloud Run service, HTTPS load balancer, managed certificate, and workspace
  instance template.
- The private agent-trace bucket stores one immutable `.jsonl.gz` object per
  completed, failed, cancelled, or interrupted run. It has no expiry rules and
  a 30-day soft-delete recovery window. Only the control-plane identity has
  create-only bucket access. VMs send archives to its authenticated ingestion
  endpoint; it verifies the signed VM identity and constructs the workspace
  path. Template/provisioning metadata supplies the control-plane origin and
  registered workspace ID for the server's `traceUpload` configuration. See the
  [trace archive documentation](../packages/workspace-server/src/traces/README.md).
- The control plane creates one workspace VM and durable workspace disk per
  user from that template. Production user workspaces are not managed by the
  standalone `workspace/` Pulumi program.
- `workspace/` remains available for an explicitly configured standalone
  development workspace. There is no active production stack in that program.

The production control plane uses these locations:

| Setting          | Value                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------ |
| GCP project      | `halo-relay`                                                                               |
| Runtime region   | `us-west2`                                                                                 |
| Workspace zone   | `us-west2-a`                                                                               |
| Public origin    | `https://gethalo.dev`                                                                      |
| Pulumi stack     | `west`                                                                                     |
| State backend    | `gs://halo-relay-pulumi-state`                                                             |
| Secrets provider | `gcpkms://projects/halo-relay/locations/us-central1/keyRings/halo-pulumi/cryptoKeys/state` |

## Authenticate and select production

Install the Google Cloud CLI and Pulumi CLI, then authenticate locally:

```sh
gcloud auth login --update-adc --project=halo-relay
pulumi login gs://halo-relay-pulumi-state
pulumi -C infra/control-plane stack select west
```

Preview and deploy from the repository root:

```sh
pnpm infra:control-plane:preview
pnpm infra:control-plane:up
```

Always review the selected stack and preview before applying a change. The
Cloud SQL instance, application secrets, and Cloud Run service have deletion
protection in both their GCP configuration and Pulumi state.
The load balancer's static IP address is also protected in Pulumi.

Normal production changes ship through a release PR created by
`pnpm prerelease <version>`. CI previews this stack on the PR. Merging builds the
versioned images, applies the stack, updates containers on the existing workspace
VMs, and publishes the desktop release. The local commands above remain
available for recovery and infrastructure development.

## Workspace image rollout

The release matrix runs `infra/workspace/rollout.sh` for each workspace.
It checks workspace identity, the durable disk, and the template's machine,
network, tags, and service account. A mismatch stops publishing and requires
explicit VM maintenance; image rollout does not change those host settings or
the boot OS.

The script updates VM metadata with the desired startup script, preserving owner
and workspace identity, then reruns it over IAP SSH. The startup script pulls the
new image before changing the service and restarting only the container. The VM,
private IP, mounted disk, and Docker cache stay in place. Healthy retries report
readiness without restarting. After the replacement is healthy, the previous
image is removed to keep release images from filling the boot disk. If pulling
fails, the existing container continues serving; the desired metadata remains
available for a retry or reboot.

The workflow requires a fresh readiness marker with the exact image, supported
protocols, and revision before browser or desktop publishing. A container startup
or health failure blocks publishing; automatic rollback and draining active agent
runs are not implemented. The restart still briefly interrupts active work.

The `deploymentServiceAccount` stack setting must match
`GCP_DEPLOY_SERVICE_ACCOUNT` in GitHub. Pulumi manages OS Admin Login, IAP access
restricted to SSH, and access to the workspace runtime service account. Existing
IAP firewall rules keep SSH reachable through IAP while workspace ports stay
private.

The deployment identity also needs `roles/logging.configWriter` to manage the
webhook request-log exclusion. Pulumi declares this binding before the exclusion;
it must never be removed to work around a deployment permission failure.
It also needs `roles/pubsub.admin` to provision the Gmail topic, push subscription
and topic publisher policy. Pulumi grants this role before creating the topic,
and waits for the deployer's push-identity act-as binding before creating the
authenticated subscription. These permissions belong to the deployment identity,
not workspace runtime accounts.

Stopped and suspended workspaces receive the desired metadata before the rollout
starts or resumes them. The rollout waits for SSH, then verifies readiness as
usual. Startup uses a VM-local lock so automatic boot startup and the release's
SSH invocation cannot change the service concurrently. Other transitional VM
states require retrying after the transition completes.

## Bootstrap resources

For a new project only, create the backend prerequisites from the repository
root:

```sh
pnpm infra:bootstrap
pulumi login gs://halo-relay-pulumi-state
```

`bootstrap.sh` enables the required APIs and creates the private, versioned
state bucket and KMS encryption key in `us-central1`. It is safe to rerun after
an interrupted setup. The deployment identity needs permission to enable
services, manage the state bucket, and create and use the KMS key. Workspace
runtime identities must not have access to the state bucket or key.

## Manually build and deploy images

Build the control-plane image with outputs from the `west` stack:

```sh
image="$(pulumi -C infra/control-plane stack output controlPlaneImageRepository --stack west):$(git rev-parse --short HEAD)"
bucket="$(pulumi -C infra/control-plane stack output buildSourceBucket --stack west)"
builder="$(pulumi -C infra/control-plane stack output buildServiceAccount --stack west)"
gcloud builds submit . \
  --project=halo-relay \
  --region=us-west2 \
  --config=infra/controlplane.cloudbuild.yaml \
  --ignore-file=infra/buildignore \
  --gcs-source-staging-dir="gs://$bucket/source" \
  --service-account="$builder" \
  --substitutions="_IMAGE=$image"

pulumi -C infra/control-plane config set controlPlaneImage "$image" --stack west
```

Build the workspace-server image the same way:

```sh
image="$(pulumi -C infra/control-plane stack output imageRepository --stack west):$(git rev-parse --short HEAD)"
bucket="$(pulumi -C infra/control-plane stack output buildSourceBucket --stack west)"
builder="$(pulumi -C infra/control-plane stack output buildServiceAccount --stack west)"
gcloud builds submit . \
  --project=halo-relay \
  --region=us-west2 \
  --config=infra/cloudbuild.yaml \
  --ignore-file=infra/buildignore \
  --gcs-source-staging-dir="gs://$bucket/source" \
  --service-account="$builder" \
  --substitutions="_IMAGE=$image"

pulumi -C infra/control-plane config set workspaceImage "$image" --stack west
```

Cloud Build uses Buildx to push images and export all build stages to an Artifact
Registry cache. Workspace builds use `workspace-server:build-cache`; control-plane
builds use `control-plane:build-cache-<target>` so the parallel transition and
frontend builds do not overwrite each other. Missing caches are populated by the
first successful build. Dependency manifests, Python requirements, and Chromium
installation precede source copies, so source-only changes reuse those layers.
The existing repository and builder permissions cover the caches; no separate
infrastructure is required. To test without updating release caches, pass
`_CACHE_IMAGE=<isolated-cache-image>` in the Cloud Build substitutions.

Use the immutable digest printed by Buildx when updating either stack
configuration value.

## OAuth and runtime secrets

Production Google OAuth credentials live in Secret Manager as:

- `halo-west-control-plane-google-client-id`
- `halo-west-control-plane-google-client-secret`
- `halo-workspace-google-web-client-id`
- `halo-workspace-google-web-client-secret`

`prod` reads the same sign-in client secrets. The control plane loads its
sign-in client through its runtime service account.
Every workspace-server app loads the canonical web integration client through
ADC; IAM grants each local or cloud runtime access to those two secrets. The
control-plane Google OAuth client must authorize:

```text
https://gethalo.dev/api/auth/callback/google
https://staging.gethalo.dev/api/auth/callback/google
```

The workspace web OAuth client must authorize:

```text
https://gethalo.dev/workspace/oauth/callback
https://staging.gethalo.dev/workspace/oauth/callback
```

The public origin is available as the stack output:

```sh
pulumi -C infra/control-plane stack output controlPlaneUrl --stack west
```

Electron keeps using its separate installed-application client and loopback
callback.

Local development reads the canonical workspace secrets with the active
Application Default Credentials identity. Production workspace VMs use their
attached service account to read those secrets and `together-ai-api-key`.
The workspace server uses that key for `together/deepseek-ai/DeepSeek-V4.1-Flash`;
Pulumi grants Secret Manager access to each workspace runtime.
The first Together rollout retains the Vertex AI service and workspace IAM grants
because IAM is applied before existing VMs are replaced. Remove those grants in a
later release after every workspace VM runs the Together image.

## Recovery snapshots

The completed `us-west2` migration retains these final workspace snapshots:

- `halo-user-workspace-west-final-20260912`
- `halo-dev-workspace-west-final-20260912`

Keep them until the west deployment has passed the desired acceptance window,
then remove them explicitly to stop snapshot storage charges.

References: [GCP authentication](https://www.pulumi.com/registry/packages/gcp/installation-configuration/),
[GCS backends](https://www.pulumi.com/docs/iac/operations/stack-management/using-a-diy-backend/),
[KMS secrets](https://www.pulumi.com/docs/iac/concepts/secrets/#google-cloud-key-management-service-kms).

## First GCP-to-Exe cutover

This is a coordinated data transfer, not an empty-workspace provider switch.
Keep production on GCP while the release builds images and signs the desktop.
Before the first release reads the Exe key, grant its deployment service account
Secret Manager accessor on only `exePrivateKeySecretId`. The conditional Pulumi
grant is applied later in that release; it cannot bootstrap its own earlier read.
Keep the control-plane auth secret and workspace IDs unchanged.

After the new Exe template has been published, run `workspace/migrateToExe.sh`
for each existing GCP workspace with the release's template, account-key path,
deployment tag and a private `RUNNER_TEMP` directory. It closes Chrome, stops the
source, retains a disk snapshot, copies and compares the home archive, then
pauses and tags the destination. The source must remain stopped. Its temporary
systemd drop-in deletes the migration checkpoint on any subsequent service start;
the release checks that checkpoint and its boot ID before changing providers.
A source that has restarted requires a fresh copy, even if its Exe tags remain.

Before cutover, use the normal control-plane `DatabaseService`, `AuthService`
and `WorkspaceService` on a trusted operator host to assign the copied VMs:

```text
verify GCP workspace IDs match the existing production workspace rows
verify each corresponding Exe VM has the deployment's migrated tag
start AuthService with the existing production database and auth secret
start WorkspaceService with ExeWorkspaceProvider and the production origin
for each existing owner:
    WorkspaceService.ensure(owner)  // persists a scoped key and assigns the copy
    verify guest assignment completed for the same workspace ID
    pause the guest
    add the deployment's assigned tag
```

Do not manufacture keys, put shared cloud credentials in guests, or create new
workspace rows for this operation. The operator host does not need an HTTP
listener. Assignment configures the guest; model-dependent startup may wait for
the new control plane. Once every source has a current checkpoint and every
destination has both `halo-west-migrated` and `halo-west-assigned`, retry the
release. It activates the control plane first, updates all assigned workspace
containers, verifies their normal RPC revision/protocols, then publishes clients.
The initial cutover guard fails before changing the provider if preparation is
incomplete. Later Exe releases use the ordinary workspace update path.

To abort before cutover, remove both destination migration/assignment tags and
remove `/var/lib/halo/exe-migration-stopped` before restarting the source service.
Keep its snapshot and the destination for recovery; do not reuse a stale copy.
After cutover, rollback must first copy the latest Exe edits back and use a GCP
image that understands the migrated Pi state. The old GCP image cannot read it.
