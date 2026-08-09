FROM ghcr.io/astral-sh/uv:0.11.31 AS uv

FROM oven/bun:1.3.14-alpine AS build
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY web/package.json web/package.json
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/media/package.json packages/media/package.json
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY . .
RUN bun run db:generate
RUN bun --cwd worker build

FROM oven/bun:1.3.14-alpine
ARG YT_DLP_VERSION=2026.7.4
COPY --from=uv /uv /uvx /bin/
RUN apk add --no-cache ca-certificates ffmpeg python3 \
  && uv tool install "yt-dlp==${YT_DLP_VERSION}"
WORKDIR /app
ENV NODE_ENV=production
ENV PATH="/root/.local/bin:${PATH}"
COPY --from=build /app /app
CMD ["bun", "--cwd", "worker", "start"]
