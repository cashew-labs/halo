# Halo releases

Each JSON file records one coordinated Halo release. Create these files through
`pnpm prerelease <version>`; merging the generated release PR deploys the cloud
services and then publishes the desktop application.

Release PRs run all package E2Es, including packaged Electron, and preview the
production infrastructure. The required `Release ready` check gates merge on
both. E2Es do not run on ordinary PRs or again after merging a release PR.
