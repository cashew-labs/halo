# Workspace image layer comparison (Tue Oct 13 17:56:31 UTC 2026)
- build ws-main: exit 0, 215s, size 1.5G
- build ws-new: exit 0, 156s, size 1.4G
- build ws-new-src: exit 0, 11s, size 1.4G
- build ws-main-src: exit 0, 42s, size 1.5G
## Source-only change: new layers
- new Dockerfile: 5 changed layers
```
0B	LABEL org.opencontainers.image.revision=02edbfe92524571817a8a58e92f22daa6c800593
0B	ENV HALO_BUILD_VERSION=test HALO_BUILD_REVISION=02edbfe92524571817a8a58e92f22daa6c800593
0B	ARG REVISION=02edbfe92524571817a8a58e92f22daa6c800593
0B	ARG VERSION=test
0B	CMD ["/opt/halo/apps/workspace-server/container.json"]
0B	ENTRYPOINT ["bash" "/opt/halo/apps/workspace-server/desktop/start.sh"]
0B	HEALTHCHECK &{["CMD-SHELL" "node --import /opt/halo/node_modules/tsx/dist/loader.mjs /opt/halo/packages/halo-cli/src/cli.ts status --json
4.1kB	WORKDIR /home/node/documents
0B	USER node
16.4kB	RUN |2 CHROME_REFRESH=2026-W42 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false /bin/sh -c mkdir -p /home/node/documents && chown node:node /
0B	ENV HOME=/home/node DISPLAY=:1 HALO_DESKTOP_ORIGIN=http://127.0.0.1:6080 VIRTUAL_ENV=/opt/halo/.venv XDG_CONFIG_HOME=/home/node/.config X
28.6MB	RUN |2 CHROME_REFRESH=2026-W42 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false /bin/sh -c chown -R node:node /opt/halo/packages # buildkit
160kB	RUN |2 CHROME_REFRESH=2026-W42 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false /bin/sh -c pnpm --filter @get-halo/workspace-server run build 
49.2kB	RUN |2 CHROME_REFRESH=2026-W42 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false /bin/sh -c cp apps/workspace-server/desktop/index.html apps/w
```
- main Dockerfile: 6 changed layers
```
0B	LABEL org.opencontainers.image.revision=02edbfe92524571817a8a58e92f22daa6c800593
0B	ENV HALO_BUILD_VERSION=test HALO_BUILD_REVISION=02edbfe92524571817a8a58e92f22daa6c800593
0B	ARG VERSION=test
0B	CMD ["/opt/halo/apps/workspace-server/container.json"]
0B	ENTRYPOINT ["bash" "/opt/halo/apps/workspace-server/desktop/start.sh"]
0B	HEALTHCHECK &{["CMD-SHELL" "node --import /opt/halo/node_modules/tsx/dist/loader.mjs /opt/halo/packages/halo-cli/src/cli.ts status --json
4.1kB	WORKDIR /home/node/documents
0B	USER node
16.4kB	RUN |2 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false REVISION=02edbfe92524571817a8a58e92f22daa6c800593 /bin/sh -c mkdir -p /home/node/docu
0B	ENV HOME=/home/node DISPLAY=:1 HALO_DESKTOP_ORIGIN=http://127.0.0.1:6080 VIRTUAL_ENV=/opt/halo/.venv XDG_CONFIG_HOME=/home/node/.config X
465MB	RUN |2 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false REVISION=02edbfe92524571817a8a58e92f22daa6c800593 /bin/sh -c curl --fail --location --
0B	ARG REVISION=02edbfe92524571817a8a58e92f22daa6c800593
28.6MB	RUN |1 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false /bin/sh -c chown -R node:node /opt/halo/packages # buildkit
160kB	RUN |1 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false /bin/sh -c pnpm --filter @get-halo/workspace-server run build     && pnpm --filter @ge
```
- build ws-new-dep: exit 0, 104s, size 1.4G
- build ws-main-dep: exit 0, 160s, size 1.5G
## Manifest change: new layers
```
0B	LABEL org.opencontainers.image.revision=02edbfe92524571817a8a58e92f22daa6c800593
0B	ENV HALO_BUILD_VERSION=test HALO_BUILD_REVISION=02edbfe92524571817a8a58e92f22daa6c800593
0B	ARG REVISION=02edbfe92524571817a8a58e92f22daa6c800593
0B	ARG VERSION=test
0B	CMD ["/opt/halo/apps/workspace-server/container.json"]
0B	ENTRYPOINT ["bash" "/opt/halo/apps/workspace-server/desktop/start.sh"]
0B	HEALTHCHECK &{["CMD-SHELL" "node --import /opt/halo/node_modules/tsx/dist/loader.mjs /opt/halo/packages/halo-cli/src/cli.ts status --json
4.1kB	WORKDIR /home/node/documents
0B	USER node
16.4kB	RUN |2 CHROME_REFRESH=2026-W42 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false /bin/sh -c mkdir -p /home/node/documents && chown node:node /
0B	ENV HOME=/home/node DISPLAY=:1 HALO_DESKTOP_ORIGIN=http://127.0.0.1:6080 VIRTUAL_ENV=/opt/halo/.venv XDG_CONFIG_HOME=/home/node/.config X
28.6MB	RUN |2 CHROME_REFRESH=2026-W42 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false /bin/sh -c chown -R node:node /opt/halo/packages # buildkit
160kB	RUN |2 CHROME_REFRESH=2026-W42 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false /bin/sh -c pnpm --filter @get-halo/workspace-server run build 
49.2kB	RUN |2 CHROME_REFRESH=2026-W42 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false /bin/sh -c cp apps/workspace-server/desktop/index.html apps/w
131kB	COPY apps/workspace-server ./apps/workspace-server # buildkit
4.31MB	COPY packages ./packages # buildkit
```
```
0B	LABEL org.opencontainers.image.revision=02edbfe92524571817a8a58e92f22daa6c800593
0B	ENV HALO_BUILD_VERSION=test HALO_BUILD_REVISION=02edbfe92524571817a8a58e92f22daa6c800593
0B	ARG VERSION=test
0B	CMD ["/opt/halo/apps/workspace-server/container.json"]
0B	ENTRYPOINT ["bash" "/opt/halo/apps/workspace-server/desktop/start.sh"]
0B	HEALTHCHECK &{["CMD-SHELL" "node --import /opt/halo/node_modules/tsx/dist/loader.mjs /opt/halo/packages/halo-cli/src/cli.ts status --json
4.1kB	WORKDIR /home/node/documents
0B	USER node
16.4kB	RUN |2 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false REVISION=02edbfe92524571817a8a58e92f22daa6c800593 /bin/sh -c mkdir -p /home/node/docu
0B	ENV HOME=/home/node DISPLAY=:1 HALO_DESKTOP_ORIGIN=http://127.0.0.1:6080 VIRTUAL_ENV=/opt/halo/.venv XDG_CONFIG_HOME=/home/node/.config X
465MB	RUN |2 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false REVISION=02edbfe92524571817a8a58e92f22daa6c800593 /bin/sh -c curl --fail --location --
0B	ARG REVISION=02edbfe92524571817a8a58e92f22daa6c800593
28.6MB	RUN |1 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false /bin/sh -c chown -R node:node /opt/halo/packages # buildkit
160kB	RUN |1 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false /bin/sh -c pnpm --filter @get-halo/workspace-server run build     && pnpm --filter @ge
49.2kB	RUN |1 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false /bin/sh -c cp apps/workspace-server/desktop/index.html apps/workspace-server/desktop/
131kB	COPY apps/workspace-server ./apps/workspace-server # buildkit
```
## Smoke test (ws-new)
```
v22.23.3
12.1.0
chromium-1234
ffmpeg-1011
Google Chrome 155.0.8059.39 
3.11.2
node:internal/process/promises:394
    triggerUncaughtException(err, true /* fromPromise */);
    ^

browserType.launch: Executable doesn't exist at /opt/playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell
╔════════════════════════════════════════════════════════════╗
║ Looks like Playwright was just installed or updated.       ║
║ Please run the following command to download new browsers: ║
║                                                            ║
║     npx playwright install                                 ║
║                                                            ║
║ <3 Playwright Team                                         ║
╚════════════════════════════════════════════════════════════╝
    at [eval]:1:50
    at [eval]-wrapper:6:24 {
  log: [],
  name: 'Error'
}

Node.js v22.23.3
smoke exit 1
```
DONE

## Smoke test, both images, BrowserService's launch (channel "chromium")
- ws-new: playwright chromium 151.0.7922.34; `halo --help` runs; HALO_BUILD_REVISION set; packages owned by node
- ws-main: identical
- The first smoke run used Playwright's default headless shell, which both Dockerfiles skip with --no-shell.

## Sizes
- ws-new: 1.4G compressed content, 3.8G unpacked
- ws-main: 1.5G compressed content, 3.8G unpacked
