# Local operations runbook

This runbook covers the Docker Compose deployment in this repository. Run commands from the repository root. Load credentials from the ignored `.env`; never put MinIO credentials, callback tokens or database dumps in Git.

## Health and restart

The normal stack uses both profiles:

```powershell
docker compose --env-file .env -f infra/compose.yaml --profile app --profile dev-ai ps
docker exec volleyball-monitoring-ai-server-1 wget -qO- http://127.0.0.1:4000/health/ready
```

Restart stateful dependencies one at a time, waiting for `healthy` and Server readiness before continuing. A safe order is Redis, Server, workers, MinIO, PostgreSQL. Do not remove or recreate volumes during a restart drill. Afterward compare canonical row counts, an object SHA/byte length and all container restart counts to the pre-drill record.

## YouTube Live relay and real-time replay simulation

The optional `youtube-relay` profile resolves a YouTube URL with an uv-managed, pinned `yt-dlp`, reads it at media rate with FFmpeg and publishes H.264/AAC to an already registered OvenMediaEngine stream. OME remains the live/LL-HLS/recording adapter: finalized MP4 recordings enter the ordinary media-indexer path, server DVR timeline and bounded playback-window API. The browser never receives the YouTube signed source URL.

Normally create the source in the New Match flow. For a manual drill, register a capture first and use an OME-safe stream name that exactly matches `YOUTUBE_INGEST_PATH`, for example `youtube-live`. Then start only the optional relay profile without storing the source URL in `.env`:

```powershell
$env:YOUTUBE_SOURCE_URL = 'https://www.youtube.com/live/VIDEO_ID'
$env:YOUTUBE_INGEST_PATH = 'youtube-live'
try {
  docker compose --env-file .env -f infra/compose.yaml --profile youtube-relay up -d --build youtube-relay
} finally {
  Remove-Item Env:YOUTUBE_SOURCE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:YOUTUBE_INGEST_PATH -ErrorAction SilentlyContinue
}
docker logs -f volleyball-monitoring-ai-youtube-relay-1
```

For an active broadcast, the relay starts at the current live edge. For a completed former livestream, FFmpeg `-re` replays the recording at real-time speed, which exercises the same ingest, growing server buffer, recording and DVR paths. The default is intentionally strict: 1920×1080 H.264 at 59–61 fps plus AAC. It accepts either one combined HLS URL or separate video/audio URLs and stream-copies both into RTMP; it fails closed rather than silently dropping to 720p or 30 fps. Override `YOUTUBE_FORMAT` only as an explicit operator decision. If the finite source ends or the container restarts, `restart: unless-stopped` starts that source again from its beginning.

To stop cleanly, stop the publisher first, wait for OME to finalize the last recording, and then close the matching capture from the stream-source dialog:

```powershell
docker compose --env-file .env -f infra/compose.yaml --profile youtube-relay stop youtube-relay
```

Only ingest or record streams when the operator has the required rights and the action complies with the source platform's terms. This development relay does not bypass access controls, DRM or geographic restrictions.

The OME recording watcher persists a restart marker before notifying the indexer. A recorder-file PTS reset opens a new `CaptureEpoch` but stays in the current playback discontinuity; only an observed source restart, time-base/timestamp discontinuity or real gap increments the playback discontinuity. Verify a captured spool with actual ffprobe sample tables:

```powershell
bun run media:reconnect-smoke -- C:\path\to\recording-spool youtube-live
```

The command must report contiguous canonical frame indices, monotonic capture time, unchanged discontinuity across ordinary recorder files and exactly one increment at the persisted reconnect marker. It never derives sample identity from average FPS or recording filenames.

## Metrics and aggregate audit

The Server exposes Prometheus metrics and a payload-free audit summary on the internal container network only:

```powershell
docker exec volleyball-monitoring-ai-server-1 bun -e "const response = await fetch('http://127.0.0.1:4000/internal/metrics'); process.stdout.write(await response.text())"
docker exec volleyball-monitoring-ai-server-1 bun -e "const response = await fetch('http://127.0.0.1:4000/internal/audit/summary'); console.log(JSON.stringify(await response.json(), null, 2))"
```

Traefik intentionally has no `/internal/**` router. A deployment-owned Prometheus must scrape `server:4000/internal/metrics` from an authorized internal network; do not expose the route with a public `PathPrefix` rule. The audit summary contains aggregate states and timestamps only, not annotation/callback payloads, tokens, object keys or user identity. Alert thresholds and audit retention remain production decisions.

## Consistent backup boundary

Use a maintenance window. Stop new capture/annotation writes and pause the six worker roles before starting a cross-store backup. A database dump and object mirror are not one atomic transaction, so record the start/end time and retain both artifacts as one backup set.

### PostgreSQL

Create a custom-format dump inside the PostgreSQL container, copy it off-container, then hash it:

```powershell
$BackupName = "volleyball-$((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')).dump"
$HostBackup = Join-Path (Resolve-Path '.').Path "backups\$BackupName"
New-Item -ItemType Directory -Force -Path (Split-Path $HostBackup) | Out-Null
docker exec volleyball-monitoring-ai-postgres-1 pg_dump -U volleyball -d volleyball -Fc -f "/tmp/$BackupName"
docker exec volleyball-monitoring-ai-postgres-1 pg_restore --list "/tmp/$BackupName"
docker cp "volleyball-monitoring-ai-postgres-1:/tmp/$BackupName" $HostBackup
Get-FileHash -Algorithm SHA256 -LiteralPath $HostBackup
```

Restore into a new, explicitly named database first. Never test a restore over `volleyball`:

```powershell
$RestoreDb = 'volleyball_restore_verify'
docker exec volleyball-monitoring-ai-postgres-1 psql -U volleyball -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $RestoreDb;"
docker cp $HostBackup "volleyball-monitoring-ai-postgres-1:/tmp/$BackupName"
docker exec volleyball-monitoring-ai-postgres-1 pg_restore -U volleyball -d $RestoreDb --no-owner --no-privileges "/tmp/$BackupName"
docker exec volleyball-monitoring-ai-postgres-1 psql -U volleyball -d $RestoreDb -c '\dt'
```

Compare migrations and canonical counts before considering a production cutover. Drop only the explicitly named verification database after review.

### MinIO

Mirror all four buckets to an off-container host directory using the pinned Compose network and credentials from `.env`:

```powershell
$ObjectBackup = Join-Path (Resolve-Path '.').Path "backups\objects-$((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))"
New-Item -ItemType Directory -Force -Path $ObjectBackup | Out-Null
docker run --rm --network volleyball-internal --env-file .env -v "${ObjectBackup}:/backup" --entrypoint /bin/sh quay.io/minio/mc:latest -c 'set -eu; mc alias set local http://minio:9000 "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" >/dev/null; for bucket in raw-media dvr-media rally-media analysis-artifacts; do mkdir -p "/backup/$bucket"; mc mirror --overwrite "local/$bucket" "/backup/$bucket"; done'
```

Restore verification must target a new bucket, compare recursive object counts and representative object checksums, then remove only that temporary bucket. Do not mirror a test restore over a production bucket.

## Retention

Retention durations are an explicit deployment decision. This repository intentionally provides no destructive default. Before enabling lifecycle deletion, the operator must record approved durations for raw media, full DVR, canonical Rally clips and analysis artifacts; legal/audit holds and backup RPO must be considered separately. Run a read-only candidate inventory first and review its object count/bytes. Never infer retention days from development fixtures.

PostgreSQL canonical submissions, operation receipts, score ledger and audit identity are not deleted by a MinIO lifecycle rule. Any future database retention job requires its own ADR, dry-run report and foreign-key-safe policy.

## Local TLS

The iPad PWA and WebSocket require a trusted HTTPS origin. Follow [Traefik TLS setup](../infra/traefik/README.md) and install the generated `mkcert` root CA on every test device. A one-session browser bypass is not production acceptance.
