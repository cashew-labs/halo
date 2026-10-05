FROM node:22-bookworm

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
WORKDIR /opt/halo

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl poppler-utils python3 python3-pip python3-venv \
       tigervnc-standalone-server novnc websockify dbus-x11 xfwm4 xfce4-panel \
       xfce4-settings thunar xfce4-terminal x11-utils x11-xserver-utils \
       adwaita-icon-theme fonts-dejavu xdg-utils \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@12.1.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY apps/workspace-server/pdf-requirements.txt ./apps/workspace-server/pdf-requirements.txt
RUN python3 -m venv /opt/halo/.venv \
    && /opt/halo/.venv/bin/pip install --no-cache-dir --requirement apps/workspace-server/pdf-requirements.txt
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
RUN pnpm exec playwright install --with-deps chromium --no-shell
COPY packages ./packages
COPY apps/workspace-server ./apps/workspace-server
RUN cp apps/workspace-server/desktop/index.html /usr/share/novnc/index.html \
    && cp apps/workspace-server/desktop/chrome.sh /usr/local/bin/halo-chrome \
    && chmod +x /usr/local/bin/halo-chrome
RUN pnpm --filter @get-halo/extension-sdk run build \
    && pnpm --filter @get-halo/extension-tools run build
# The workspace CLI builds and packs the local SDK when authoring extensions.
RUN chown -R node:node /opt/halo/packages

# Refresh Chrome for each release revision without invalidating dependency layers.
ARG REVISION=local
# The desktop uses Google Chrome; BrowserService keeps Playwright's Chromium.
RUN curl --fail --location --silent --show-error \
      "https://dl.google.com/linux/direct/google-chrome-stable_current_$(dpkg --print-architecture).deb" \
      --output /tmp/google-chrome-stable.deb \
    && apt-get update \
    && apt-get install --yes --no-install-recommends /tmp/google-chrome-stable.deb \
    && rm -f /tmp/google-chrome-stable.deb \
    && rm -rf /var/lib/apt/lists/*

ENV HOME=/home/node \
    DISPLAY=:1 \
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
ENTRYPOINT ["dbus-run-session", "--", "bash", "/opt/halo/apps/workspace-server/desktop/start.sh"]
CMD ["/opt/halo/apps/workspace-server/container.json"]

ARG VERSION=dev
ENV HALO_BUILD_VERSION=$VERSION HALO_BUILD_REVISION=$REVISION
LABEL org.opencontainers.image.revision=$REVISION
