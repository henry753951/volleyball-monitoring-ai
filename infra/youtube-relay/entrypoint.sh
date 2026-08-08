#!/bin/sh
set -eu

: "${YOUTUBE_SOURCE_URL:?YOUTUBE_SOURCE_URL is required}"
: "${MEDIA_INGEST_URL:?MEDIA_INGEST_URL is required}"

format="${YOUTUBE_FORMAT:-best[protocol*=m3u8][height=1080][fps>=59][fps<=61][vcodec^=avc][acodec!=none]/bestvideo[height=1080][fps>=59][fps<=61][vcodec^=avc]+bestaudio[acodec^=mp4a]}"
extractor_args="${YOUTUBE_EXTRACTOR_ARGS:-youtube:player_client=android_vr}"

echo "youtube-relay: resolving source and publishing to configured OvenMediaEngine ingest path"
stream_urls="$(yt-dlp \
  --no-playlist \
  --no-progress \
  --no-warnings \
  --extractor-args "$extractor_args" \
  --format "$format" \
  --get-url \
  "$YOUTUBE_SOURCE_URL")"

set -f
old_ifs="$IFS"
IFS='
'
set -- $stream_urls
IFS="$old_ifs"

case "$#" in
  1)
    exec ffmpeg \
      -nostdin -hide_banner -loglevel warning \
      -re -i "$1" \
      -map 0:v:0 -map 0:a:0? \
      -c copy -flvflags no_duration_filesize -f flv \
      "$MEDIA_INGEST_URL"
    ;;
  2)
    exec ffmpeg \
      -nostdin -hide_banner -loglevel warning \
      -re -i "$1" -re -i "$2" \
      -map 0:v:0 -map 1:a:0 \
      -c copy -flvflags no_duration_filesize -f flv \
      "$MEDIA_INGEST_URL"
    ;;
  *)
    echo "youtube-relay: expected one combined URL or separate video/audio URLs" >&2
    exit 1
    ;;
esac
