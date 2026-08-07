FROM ghcr.io/astral-sh/uv:python3.12-alpine

ARG YT_DLP_VERSION=2026.7.4

RUN apk add --no-cache ca-certificates ffmpeg \
  && uv tool install "yt-dlp==${YT_DLP_VERSION}"

COPY --chmod=0555 infra/youtube-relay/entrypoint.sh /usr/local/bin/youtube-relay

ENTRYPOINT ["/usr/local/bin/youtube-relay"]
