# syntax=docker/dockerfile:1
# UHPPOTE Desk production image (Node.js server + compiled React frontend).
# Build from the project root:  docker build -f docker/Dockerfile -t uhppote-desk .

# --- build ---------------------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY tools/hwtest/package.json tools/hwtest/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY tools ./tools
RUN npm run build --workspace @uhppote-desk/web \
 && npm run build --workspace @uhppote-desk/server \
 && npm run build --workspace @uhppote-desk/hwtest

# --- runtime dependencies ------------------------------------------------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY tools/hwtest/package.json tools/hwtest/
RUN npm ci --omit=dev --workspace @uhppote-desk/server --include-workspace-root=false --no-audit --no-fund

# --- runtime ------------------------------------------------------------------
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PUID=1000 \
    PGID=1000 \
    DATA_DIR=/data \
    HWTEST_REPORT_DIR=/data/reports \
    WEB_DIR=/app/web \
    HTTP_PORT=8080 \
    UHPPOTE_LISTEN=0.0.0.0:60001
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends iputils-ping && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/apps/server/dist ./server
COPY --from=build /app/apps/web/dist ./web
COPY --from=build /app/tools/hwtest/dist ./hwtest
COPY docker/entrypoint.sh /usr/local/bin/uhppote-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/uhppote-entrypoint && chmod 0755 /usr/local/bin/uhppote-entrypoint \
 && mkdir -p /data && chown node:node /data
# The container starts as root only to prepare /data (also when it is a host bind mount);
# the entrypoint then runs the application as PUID:PGID (default 1000:1000 = "node").
VOLUME ["/data"]
EXPOSE 8080/tcp 60001/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/uhppote-entrypoint"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/main.js"]
