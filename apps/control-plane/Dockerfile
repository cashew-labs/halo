ARG PREVIOUS_WEB_IMAGE=node:22-bookworm-slim
FROM ${PREVIOUS_WEB_IMAGE} AS previous-web
FROM node:22-bookworm-slim AS runtime

WORKDIR /opt/halo

RUN npm install --global pnpm@12.1.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages/client ./packages/client
COPY packages/config ./packages/config
COPY packages/shared ./packages/shared
COPY packages/typescript-config ./packages/typescript-config
COPY packages/web ./packages/web
COPY apps/control-plane ./apps/control-plane
COPY apps/web-app ./apps/web-app
RUN pnpm install --frozen-lockfile --filter @get-halo/control-plane... --filter @get-halo/web-app...
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
