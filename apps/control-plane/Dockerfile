FROM node:22-bookworm-slim

WORKDIR /opt/halo

RUN npm install --global pnpm@12.1.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages/config ./packages/config
COPY packages/shared ./packages/shared
COPY packages/typescript-config ./packages/typescript-config
COPY packages/web ./packages/web
COPY apps/control-plane ./apps/control-plane
COPY apps/web-app ./apps/web-app
RUN pnpm install --frozen-lockfile --filter @get-halo/control-plane... --filter @get-halo/web-app...
RUN pnpm --filter @get-halo/web-app build

ENV NODE_ENV=production
USER node
HEALTHCHECK --interval=30s --start-period=15s --timeout=5s \
    CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(response => { if (!response.ok) process.exit(1) })"
ENTRYPOINT ["node", "--import", "tsx", "apps/control-plane/src/main.ts"]
