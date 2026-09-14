# Halo releases

Each JSON file records one coordinated Halo release. Create these files through
`pnpm prerelease <version>`; merging the generated release PR deploys the cloud
services and then publishes the desktop application.
