# Releasing Halo

Halo releases to staging first, then promotes the same build to production:

1. `pnpm prerelease <version>` opens a release PR. Merging it deploys the `west`
   stack (`staging.gethalo.dev`) and publishes the desktop app to
   `cashew-labs/halo-staging`. Installs with Help > Use Staging update from there.
2. `pnpm promote <version>` opens a promotion PR that records the version in
   `releases/production.json` and pins `infra/control-plane/Pulumi.prod.yaml` to
   the images and exe.dev template staging verified. Merging it runs
   `promote.yml`: it builds a production transition image from the staged source,
   deploys the `prod` stack (`gethalo.dev`) with the shared
   `deploy-stack.yml` workflow, then copies the signed desktop artifacts from the
   staging release to `cashew-labs/halo` without rebuilding.

Production may skip staging releases. Promotion fails when the release's
`minimumFrontendVersion` is newer than the version production runs, because the
new backend would stop serving production's current clients. The staging release
notes record the source revision (`Source: cashew-labs/halo@<sha>`) that
promotion deploys and tags.

`releases/production.json` starts at `0.1.68`, the version a one-time
`pulumi up --stack prod` deploys when production is first created. Adding that
file does not deploy; every later change to it does.

The rest of this page describes one stack's deployment; staging and production
follow the same steps.

Run `pnpm prerelease <version>` from clean, current `main`. The release PR records `minimumFrontendVersion` and both API protocol requirements. The validator requires the backend to support every frontend from that minimum through the new release. The minimum carries forward; use `--minimum-frontend <version>` to deliberately retire older frontends. Additive API changes keep their protocol number; a breaking change needs an implemented, tested adapter before its protocol can be advertised.

After merge, the release workflow prepares desktop artifacts and container images in parallel:

1. Builds, signs, notarizes and verifies the desktop, then retains the exact artifacts with the release version, source SHA and archive SHA-256.
2. Builds a workspace image and two control-plane images concurrently from that source SHA. The transition image serves the previous browser bundle; the final image serves the new bundle and retains the previous hashed assets for open tabs. The previous image and all deployment references are pinned by digest. Deployment waits for all three image builds and the verified desktop artifacts to succeed.
3. Deploys the transition control plane, then recreates workspace VMs in separate Blacksmith jobs, up to ten at once, with their existing data disks. Checks the public control-plane bootstrap and authenticated, VM-local workspace CLI for the expected supported protocols and source SHA. A health-only response does not pass this gate. Every VM must report readiness before frontend publication starts.
4. Promotes the prepared browser image, verifies its API identity, and records the published image tags used by the committed Pulumi config.
5. Creates a draft GitHub release in `cashew-labs/halo-staging`, uploads the previously verified desktop artifacts without rebuilding, and makes the completed release available to the staging updater. The workflow needs a `STAGING_RELEASES_TOKEN` secret with contents write access to that repository.

The browser and desktop share this gated frontend publication phase. They are not an atomic transaction: a desktop publication failure can leave the new browser live while desktop users retain the previous compatible release. The browser remains served by the control-plane process; no additional production service is introduced.

## Recovering a failed release

Use **Re-run failed jobs** on the original workflow run. Its source SHA, image digests and retained desktop artifact identify the release. A full rerun also checks for and reuses an existing verified desktop artifact. Prepared artifacts are retained for 30 days; recover missing artifacts through a reviewed release rather than rebuilding during a publication-only retry. The old manual `workflow_dispatch` shortcut was removed because it could publish an arbitrary checkout without checking deployment readiness.

A failed backend gate blocks all frontend promotion. A partial VM rollout is reported as a failed workspace job; inspect that job before retrying it, since a failed VM may be unavailable. The other workspace jobs continue and ready VMs remain on the new image. Do not automatically roll back servers or data migrations. A publication-only retry does not repeat deployment. If the artifact digest, source SHA, protocol list or readiness check differs, stop and investigate.

The first release under this policy sets its own version as the minimum, retiring `0.1.52` (workspace protocol 17, control-plane protocol 3). A brief interruption is accepted until users update the desktop app or refresh the browser after publication. Keeping an old protocol in the advertised list is a claim that its behavior is still implemented, not a substitute for compatibility tests.
