ARG PREVIOUS_WEB_IMAGE=node:22-bookworm-slim
FROM ${PREVIOUS_WEB_IMAGE} AS previous-web
FROM node:22-bookworm-slim AS runtime

WORKDIR /opt/halo

RUN apt-get update \
    && apt-get install --yes --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@12.1.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
# Install dependencies before copying sources so code changes reuse this layer.
COPY packages/client/package.json ./packages/client/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/typescript-config/package.json ./packages/typescript-config/package.json
COPY packages/web/package.json ./packages/web/package.json
COPY apps/control-plane/package.json ./apps/control-plane/package.json
COPY apps/web-app/package.json ./apps/web-app/package.json
RUN pnpm install --frozen-lockfile --filter @get-halo/control-plane... --filter @get-halo/web-app...
COPY packages/client ./packages/client
COPY packages/config ./packages/config
COPY packages/shared ./packages/shared
COPY packages/typescript-config ./packages/typescript-config
COPY packages/web ./packages/web
COPY apps/control-plane ./apps/control-plane
COPY apps/web-app ./apps/web-app
COPY apps/electron/package.json ./apps/electron/package.json
RUN PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false pnpm --filter @get-halo/web-app build

ENV NODE_ENV=production
USER node
HEALTHCHECK --interval=30s --start-period=15s --timeout=5s \
    CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(response => { if (!response.ok) process.exit(1) })"
ENTRYPOINT ["node", "--import", "tsx", "apps/control-plane/src/main.ts"]

ARG VERSION=dev
ARG REVISION=local
ENV HALO_BUILD_VERSION=$VERSION HALO_BUILD_REVISION=$REVISION
LABEL org.opencontainers.image.revision=$REVISION

# New API, previous browser. Bootstrap and product protocols stay compatible.
FROM runtime AS transition
USER root
RUN rm -rf apps/web-app/dist
COPY --from=previous-web /opt/halo/apps/web-app/dist ./apps/web-app/dist
USER node

# Old tabs can still fetch lazy chunks after the new index.html is promoted.
FROM runtime AS frontend
COPY --from=previous-web /opt/halo/apps/web-app/dist/assets ./apps/web-app/dist/assets

# Local/manual builds do not require an existing production image.
FROM runtime AS standalone
