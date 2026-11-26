# syntax=docker/dockerfile:1

ARG BUN_VERSION=1.4

FROM oven/bun:${BUN_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

FROM deps AS build
COPY . .
RUN bun run build:web && bun run build:server:bundle

FROM oven/bun:${BUN_VERSION}-alpine AS runtime
LABEL org.opencontainers.image.source="https://github.com/tunitz/control-center" \
      org.opencontainers.image.description="Control Center fleet monitoring and power management dashboard"

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3030 \
    CC_DATA=/data \
    CC_WEB=/app/apps/web/dist \
    CC_AGENT_DIR=/app/agent

COPY --from=build --link --chown=1000:1000 /app/dist/server.js ./dist/server.js
COPY --from=build --link --chown=1000:1000 /app/apps/web/dist ./apps/web/dist
COPY --from=build --link --chown=1000:1000 /app/agent ./agent

RUN mkdir -p /data && chown bun:bun /data
VOLUME /data

USER bun
EXPOSE 3030

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3030/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["bun", "run", "/app/dist/server.js"]
