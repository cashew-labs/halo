# Releasing Halo

Run `pnpm prerelease <version>` from clean, current `main`. The release PR records the previous frontend version and the workspace/control-plane protocol requirements. The validator requires the new backend to retain every protocol advertised by the previous release. Additive API changes keep their protocol number; a breaking change needs an implemented, tested adapter before its protocol can be advertised. Protocol retirement requires a separate reviewed support-policy change.

After merge, the release workflow:

1. Builds, signs, notarizes and verifies the desktop, then retains the exact artifacts with the release version, source SHA and archive SHA-256.
2. Builds a workspace image and two control-plane images from that source SHA. The transition image serves the previous browser bundle; the final image serves the new bundle and retains the previous hashed assets for open tabs. The previous image and all deployment references are pinned by digest.
3. Deploys the transition control plane and recreates workspace VMs with their existing data disks. Checks the public control-plane bootstrap and authenticated, VM-local workspace CLI for the expected supported protocols and source SHA. A health-only response does not pass this gate.
4. Promotes the prepared browser image, verifies its API identity, and records the published image tags used by the committed Pulumi config.
5. Creates a draft GitHub release, uploads the previously verified desktop artifacts without rebuilding, and makes the completed release available to the updater.

The browser and desktop share this gated frontend publication phase. They are not an atomic transaction: a desktop publication failure can leave the new browser live while desktop users retain the previous compatible release. The browser remains served by the control-plane process; no additional production service is introduced.

## Recovering a failed release

Use **Re-run failed jobs** on the original workflow run. Its source SHA, image digests and retained desktop artifact identify the release. A full rerun also checks for and reuses an existing verified desktop artifact. Prepared artifacts are retained for 30 days; recover missing artifacts through a reviewed release rather than rebuilding during a publication-only retry. The old manual `workflow_dispatch` shortcut was removed because it could publish an arbitrary checkout without checking deployment readiness.

A failed backend gate blocks all frontend promotion. A partial VM rollout is reported as a deployment failure; inspect that job before retrying it, since the deployment job recreates workspace VMs. Do not automatically roll back servers or data migrations. A publication-only retry does not repeat deployment. If the artifact digest, source SHA, protocol list or readiness check differs, stop and investigate.

The first release under this policy bootstraps the preceding `0.1.52` manifest as workspace protocol 18 and control-plane protocol 3. Subsequent manifests carry the metadata explicitly. Keeping an old protocol in the advertised list is a claim that its behavior is still implemented, not a substitute for compatibility tests.
