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
COPY --from=uv /uv /uvx /bin/
ADD --checksum=sha256:1b691a73962e14cdd6263ff620a2f8257b7e5edc1b6b2a00f58542aae5d33fdd \
  https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/2026.08.17.073947/yt-dlp.tar.gz \
  /tmp/yt-dlp.tar.gz
RUN apk add --no-cache ca-certificates deno ffmpeg font-noto-cjk python3 \
  && uv tool install --prerelease allow \
    --with "bgutil-ytdlp-pot-provider==1.3.1" \
    "yt-dlp[default] @ file:///tmp/yt-dlp.tar.gz" \
  && rm /tmp/yt-dlp.tar.gz
WORKDIR /app
ENV NODE_ENV=production
ENV PATH="/root/.local/bin:${PATH}"
COPY --from=build /app /app
CMD ["bun", "--cwd", "worker", "start"]
