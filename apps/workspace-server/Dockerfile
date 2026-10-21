# Layers are ordered from least to most often changed. A changed layer rebuilds
# every layer after it, and each rebuilt layer is downloaded by every workspace.

# Pinned so the 1 GB base, and everything above it, changes only when a commit
# updates this digest (node:22-bookworm).
ARG BASE_IMAGE=node:22-bookworm@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8

FROM rust:1.97.1-bookworm AS opensky-driver
RUN apt-get update \
    && apt-get install --yes --no-install-recommends git clang pkg-config libdbus-1-dev libx11-dev libxi-dev libxtst-dev libxext-dev libxkbcommon-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Exact tested OpenSky fork; upstream CUA binaries do not implement its identity.
RUN git init . \
    && git remote add origin https://github.com/tanishqkancharla/cua.git \
    && git fetch --depth 1 origin 9e9219a0ca84ea195b9cf3be35b42a6379699448 \
    && git checkout --detach FETCH_HEAD
WORKDIR /src/libs/cua-driver/rust
RUN CUA_DRIVER_SOURCE_SHA=9e9219a0ca84ea195b9cf3be35b42a6379699448 \
    cargo build --release --locked --jobs 2 -p cua-driver

FROM ${BASE_IMAGE}

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /opt/halo

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl poppler-utils python3 python3-pip python3-venv \
       tigervnc-standalone-server novnc websockify dbus-x11 xfwm4 xfce4-panel \
       xfce4-settings thunar xfce4-terminal x11-utils x11-xserver-utils \
       at-spi2-core libatk-adaptor libxi6 libxtst6 xdotool \
       adwaita-icon-theme fonts-dejavu xdg-utils \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@12.1.0 && npm cache clean --force
COPY --from=opensky-driver /src/libs/cua-driver/rust/target/release/cua-driver /usr/local/bin/opensky-driver
COPY apps/workspace-server/pdf-requirements.txt ./apps/workspace-server/pdf-requirements.txt
RUN python3 -m venv /opt/halo/.venv \
    && /opt/halo/.venv/bin/pip install --no-cache-dir --requirement apps/workspace-server/pdf-requirements.txt
# The desktop uses Google Chrome. CI passes the ISO week, so Chrome refreshes
# weekly instead of with every commit.
ARG CHROME_REFRESH=local
RUN echo "Chrome refresh: ${CHROME_REFRESH}" \
    && curl --fail --location --silent --show-error \
      "https://dl.google.com/linux/direct/google-chrome-stable_current_$(dpkg --print-architecture).deb" \
      --output /tmp/google-chrome-stable.deb \
    && apt-get update \
    && apt-get install --yes --no-install-recommends /tmp/google-chrome-stable.deb \
    && rm -f /tmp/google-chrome-stable.deb \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
# Keep workspace manifests in the dependency layer; copy sources after installation.
COPY packages/app-control/package.json ./packages/app-control/package.json
COPY packages/client/package.json ./packages/client/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/copy-path-to-symbol/package.json ./packages/copy-path-to-symbol/package.json
COPY packages/dev-cli/package.json ./packages/dev-cli/package.json
COPY packages/extension-sdk/package.json ./packages/extension-sdk/package.json
COPY packages/extension-tools/package.json ./packages/extension-tools/package.json
COPY packages/halo-cli/package.json ./packages/halo-cli/package.json
COPY packages/logger/package.json ./packages/logger/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/typescript-config/package.json ./packages/typescript-config/package.json
COPY packages/web/package.json ./packages/web/package.json
COPY packages/workspace-server/package.json ./packages/workspace-server/package.json
COPY apps/workspace-server/package.json ./apps/workspace-server/package.json
RUN pnpm install --frozen-lockfile
ARG PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false
COPY packages ./packages
COPY apps/workspace-server ./apps/workspace-server
RUN cp apps/workspace-server/desktop/index.html apps/workspace-server/desktop/*.js /usr/share/novnc/ \
    && cp apps/workspace-server/desktop/chrome.sh /usr/local/bin/halo-chrome \
    && chmod +x /usr/local/bin/halo-chrome
RUN pnpm --filter @get-halo/workspace-server run build \
    && pnpm --filter @get-halo/extension-sdk run build \
    && pnpm --filter @get-halo/extension-tools run build
# The workspace CLI builds and packs the local SDK when authoring extensions.
RUN chown -R node:node /opt/halo/packages

ENV HOME=/home/node \
    DISPLAY=:1 \
    OPENSKY_DRIVER_BINARY=/usr/local/bin/opensky-driver \
    OPENSKY_DRIVER_SOCKET=/tmp/halo-desktop-runtime/opensky.sock \
    NO_AT_BRIDGE=0 \
    GTK_MODULES=atk-bridge \
    HALO_DESKTOP_ORIGIN=http://127.0.0.1:6080 \
    VIRTUAL_ENV=/opt/halo/.venv \
    XDG_CONFIG_HOME=/home/node/.config \
    XDG_DATA_HOME=/home/node/.local/share \
    NPM_CONFIG_PREFIX=/home/node/.local \
    PYTHONUSERBASE=/home/node/.local \
    PIP_USER=1 \
    GOPATH=/home/node/.local/share/go \
    GOBIN=/home/node/.local/bin \
    HALO_USER_DATA=/home/node/.halo/runtime \
    PATH=/home/node/documents/.halo/bin:/home/node/.local/bin:/opt/halo/.venv/bin:$PATH

RUN mkdir -p /home/node/documents && chown node:node /home/node/documents
USER node
WORKDIR /home/node/documents
HEALTHCHECK --interval=30s --start-period=120s --timeout=15s \
    CMD node --import /opt/halo/node_modules/tsx/dist/loader.mjs /opt/halo/packages/halo-cli/src/cli.ts status --json
ENTRYPOINT ["bash", "/opt/halo/apps/workspace-server/desktop/start.sh"]
CMD ["/opt/halo/apps/workspace-server/container.json"]

# Per-release metadata comes last so it never invalidates a large layer.
COPY infra/workspace/exeTemplate.sh infra/workspace/desktop-seccomp.json \
     infra/workspace/installUpdater.sh infra/workspace/workspaceUpdate.py /opt/halo/host/
ARG VERSION=dev
ARG REVISION=local
ENV HALO_BUILD_VERSION=$VERSION HALO_BUILD_REVISION=$REVISION
LABEL org.opencontainers.image.revision=$REVISION
