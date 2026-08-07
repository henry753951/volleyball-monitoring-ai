#!/bin/sh
set -eu

: "${YOUTUBE_SOURCE_URL:?YOUTUBE_SOURCE_URL is required}"
: "${MEDIA_INGEST_URL:?MEDIA_INGEST_URL is required}"

format="${YOUTUBE_FORMAT:-best[ext=mp4][height<=720][acodec!=none][vcodec!=none]/best[height<=720]}"

echo "youtube-relay: resolving source and publishing to configured MediaMTX ingest path"
yt-dlp \
  --no-playlist \
  --no-progress \
  --no-warnings \
  --format "$format" \
  --output - \
  "$YOUTUBE_SOURCE_URL" \
| ffmpeg \
  -nostdin \
  -hide_banner \
  -loglevel warning \
  -re \
  -i pipe:0 \
  -map 0:v:0 \
  -map 0:a:0? \
  -c copy \
  -f flv \
  "$MEDIA_INGEST_URL"
