# Halo infrastructure

Halo production runs in GCP project `halo-relay` with the control plane in
`us-west2` and user workspace VMs in `us-west2-a`. The active Pulumi
control-plane stack is `west`.

The Pulumi state bucket and KMS key remain in `us-central1`. They are bootstrap
resources outside the application stacks and are not on the application request
path. Do not delete or move the KMS key: the active `west` stack uses it to
decrypt Pulumi secrets.

The current Electron release connects directly to the Cloud Run default URL; a
stable custom hostname can be added separately.

## Production layout

- `control-plane/` owns the `halo-west` network, Cloud NAT, Artifact Registry,
  build-source bucket, Cloud SQL database, runtime secrets, service accounts,
  Cloud Run service, and workspace instance template.
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

Normal production changes ship through a release PR created by
`pnpm prerelease <version>`. CI previews this stack on the PR. Merging builds the
versioned images, applies the stack, recreates workspace VMs with their durable
data disks, and publishes the desktop release. The local commands above remain
available for recovery and infrastructure development.

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

Use the immutable digest printed by Cloud Build when updating either stack
configuration value.

## OAuth and runtime secrets

Production Google OAuth credentials live in Secret Manager as:

- `halo-west-control-plane-google-client-id`
- `halo-west-control-plane-google-client-secret`
- `halo-west-workspace-google-web-client-id`
- `halo-west-workspace-google-web-client-secret`

The control plane loads its sign-in client through its runtime service account.
Workspace VMs load the web integration client through their runtime service
account. Add
`${controlPlaneUrl}/api/auth/callback/google` as an authorized redirect URI on
the Google OAuth client, where `controlPlaneUrl` comes from:

```sh
pulumi -C infra/control-plane stack output controlPlaneUrl --stack west
```

The workspace web OAuth client uses
`${controlPlaneUrl}/workspace/oauth/callback`. Electron keeps using its separate
installed-application client and loopback callback.

Local development uses separate `halo-dev-local-*` secrets and the active
Application Default Credentials identity. Production workspace VMs use their
attached service account for `google-vertex/gemini-3.8-flash`; Pulumi grants it
`roles/aiplatform.user`.

## Recovery snapshots

The completed `us-west2` migration retains these final workspace snapshots:

- `halo-user-workspace-west-final-20260912`
- `halo-dev-workspace-west-final-20260912`

Keep them until the west deployment has passed the desired acceptance window,
then remove them explicitly to stop snapshot storage charges.

References: [GCP authentication](https://www.pulumi.com/registry/packages/gcp/installation-configuration/),
[GCS backends](https://www.pulumi.com/docs/iac/operations/stack-management/using-a-diy-backend/),
[KMS secrets](https://www.pulumi.com/docs/iac/concepts/secrets/#google-cloud-key-management-service-kms).
