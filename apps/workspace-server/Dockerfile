FROM node:22-bookworm

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /opt/halo

RUN apt-get update \
    && apt-get install --yes --no-install-recommends poppler-utils python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@12.1.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages ./packages
COPY apps/workspace-server ./apps/workspace-server
RUN python3 -m venv /opt/halo/.venv \
    && /opt/halo/.venv/bin/pip install --no-cache-dir --requirement apps/workspace-server/pdf-requirements.txt
RUN pnpm install --frozen-lockfile
ARG PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false
RUN pnpm --filter @get-halo/extension-sdk run build \
    && pnpm --filter @get-halo/extension-tools run build \
    && pnpm exec playwright install --with-deps chromium --no-shell
# The workspace CLI builds and packs the local SDK when authoring extensions.
RUN chown -R node:node /opt/halo/packages

ENV HOME=/home/node \
    VIRTUAL_ENV=/opt/halo/.venv \
    XDG_CONFIG_HOME=/home/node/.config \
    XDG_DATA_HOME=/home/node/.local/share \
    NPM_CONFIG_PREFIX=/home/node/.local \
    PYTHONUSERBASE=/home/node/.local \
    PIP_USER=1 \
    GOPATH=/home/node/.local/share/go \
    GOBIN=/home/node/.local/bin \
    HALO_USER_DATA=/home/node/.halo/runtime \
    PATH=/home/node/.halo/bin:/home/node/.local/bin:/opt/halo/.venv/bin:$PATH

USER node
WORKDIR /home/node
HEALTHCHECK --interval=30s --start-period=120s --timeout=15s \
    CMD node --import /opt/halo/node_modules/tsx/dist/loader.mjs /opt/halo/packages/halo-cli/src/cli.ts status --json
ENTRYPOINT ["node", "--import", "/opt/halo/node_modules/tsx/dist/loader.mjs", "/opt/halo/apps/workspace-server/src/main.ts"]
CMD ["/opt/halo/apps/workspace-server/container.json"]

ARG VERSION=dev
ARG REVISION=local
ENV HALO_BUILD_VERSION=$VERSION HALO_BUILD_REVISION=$REVISION
LABEL org.opencontainers.image.revision=$REVISION
