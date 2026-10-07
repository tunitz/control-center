FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:web

FROM oven/bun:1.4-slim
WORKDIR /app
COPY --from=build /app /app
ENV CC_DATA=/data PORT=3030
VOLUME /data
EXPOSE 3030
CMD ["bun", "run", "apps/server/src/index.ts"]
