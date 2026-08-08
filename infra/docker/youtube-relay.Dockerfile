FROM ghcr.io/astral-sh/uv:python3.12-alpine

ARG YT_DLP_VERSION=2026.7.4

RUN apk add --no-cache ca-certificates ffmpeg \
  && uv tool install "yt-dlp==${YT_DLP_VERSION}"

COPY --chmod=0555 infra/youtube-relay/entrypoint.sh /usr/local/bin/youtube-relay

# Windows worktrees can check shell scripts out with CRLF. Normalize inside the
# image so the Linux shebang remains executable regardless of host Git config.
RUN sed -i 's/\r$//' /usr/local/bin/youtube-relay

ENTRYPOINT ["/usr/local/bin/youtube-relay"]
