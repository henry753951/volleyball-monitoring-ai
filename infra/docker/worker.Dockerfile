FROM ghcr.io/astral-sh/uv:0.11.31 AS uv

FROM oven/bun:1.3.14-alpine AS ffmpeg-build
ADD --checksum=sha256:12d934b0c5d03f0d8abbd0121f01fa4efb0969ff8d55f3cf98aeb08f598c0f5d \
  https://github.com/FFmpeg/FFmpeg/archive/89153eb701d372f54a5d7d29de5067abc09e11d3.tar.gz \
  /tmp/ffmpeg.tar.gz
RUN apk add --no-cache \
    build-base \
    bzip2-dev \
    fontconfig-dev \
    freetype-dev \
    libass-dev \
    nasm \
    openssl-dev \
    pkgconf \
    x264-dev \
    yasm \
    zlib-dev \
  && mkdir -p /tmp/ffmpeg-src \
  && tar -xzf /tmp/ffmpeg.tar.gz --strip-components=1 -C /tmp/ffmpeg-src \
  && cd /tmp/ffmpeg-src \
  && ./configure \
    --prefix=/opt/ffmpeg \
    --disable-debug \
    --disable-doc \
    --disable-ffplay \
    --enable-libfontconfig \
    --enable-libfreetype \
    --enable-gpl \
    --enable-libass \
    --enable-libx264 \
    --enable-openssl \
    --enable-version3 \
  && make -j"$(getconf _NPROCESSORS_ONLN)" \
  && make install \
  && /opt/ffmpeg/bin/ffmpeg -hide_banner -h protocol=http 2>&1 \
    | grep -Eq -- '-request_size|-initial_request_size|-multiple_requests|-short_seek_size' \
  && test "$(/opt/ffmpeg/bin/ffmpeg -hide_banner -h protocol=http 2>&1 \
    | grep -Ec -- '-request_size|-initial_request_size|-multiple_requests|-short_seek_size')" -eq 4 \
  && rm -rf /tmp/ffmpeg-src /tmp/ffmpeg.tar.gz

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
COPY --from=ffmpeg-build /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg-build /opt/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe
WORKDIR /app
ENV NODE_ENV=production
ENV PATH="/root/.local/bin:${PATH}"
COPY --from=build /app /app
CMD ["bun", "--cwd", "worker", "start"]
