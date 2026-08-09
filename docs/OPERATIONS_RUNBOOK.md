# Local operations runbook

This runbook covers the Docker Compose deployment in this repository. Run commands from the repository root. Load credentials from the ignored `.env`; never put MinIO credentials, callback tokens or database dumps in Git.

## Health and restart

The full central stack uses the `app` profile. Provision or validate object-storage buckets before
starting application containers:

```powershell
$env:OBJECT_STORAGE_BOOTSTRAP_MODE = 'validate' # production; use ensure only for local development
bun run storage:bootstrap
docker compose --env-file .env -f infra/compose.yaml --profile app ps
docker exec volleyball-monitoring-ai-server-1 wget -qO- http://127.0.0.1:4000/health/ready
```

Daily host development uses `bun run dev:infra`; it starts only PostgreSQL, Redis, MinIO and OME,
then runs the idempotent bucket bootstrap in `ensure` mode. `bun run dev:https` additionally starts
Traefik and routes the existing same-origin paths to host ports 4000/3100. Start the application with
`bun run dev`; the supervisor maps only infrastructure DNS names to loopback endpoints and shuts all
four host children down together. No bucket-provisioning container remains in Compose.

`worker-media` and `worker-workflow` expose internal readiness documents on ports 4101 and 4102.
Each document reports component heartbeat, last success/error, active work, failures and known
backlog. A failed media indexer or clip loop is `unhealthy`; a failed maintenance loop such as
playback cleanup is `degraded` and does not restart otherwise healthy siblings.

Restart stateful dependencies one at a time, waiting for `healthy` and Server readiness before continuing. A safe order is Redis, Server, workers, MinIO, PostgreSQL. Do not remove or recreate volumes during a restart drill. Afterward compare canonical row counts, an object SHA/byte length and all container restart counts to the pre-drill record.

## YouTube and uploaded MP4 sources

Create YouTube VOD, YouTube Live and uploaded MP4 sources from the New Match flow. Server persists a `MediaSourceWork` request and returns immediately; `worker-media` claims it with a PostgreSQL lease. It uses the uv-managed, pinned `yt-dlp` plus FFmpeg, classifies YouTube VOD versus Live, and writes lifecycle state directly to PostgreSQL. There is no internal media gateway or callback HTTP hop, and the browser never receives a signed YouTube media URL.

For active broadcasts, `worker-media` publishes the selected FHD 60 fps H.264/AAC inputs to OvenMediaEngine. OME remains the live/LL-HLS/recording adapter. Uploaded MP4 and YouTube VOD are converted into resumable two-second fragmented-MP4 recordings directly in the same spool. The embedded recording monitor waits for stable size/mtime observations before indexing; PostgreSQL job identities and ingest reservations provide restart idempotency.

Run the host process during normal development:

```powershell
bun run dev:infra
bun run dev
Invoke-RestMethod http://127.0.0.1:4101/health/ready
Invoke-RestMethod http://127.0.0.1:4102/health/ready
```

In the full profile, inspect the composed worker instead:

```powershell
docker logs -f volleyball-monitoring-ai-worker-media-1
```

The default format is intentionally strict: 1920×1080 H.264 at 59–61 fps plus AAC. It accepts one combined input or separate video/audio inputs and fails closed rather than silently dropping to 720p or 30 fps. Override `YOUTUBE_FORMAT` only as an explicit operator decision. Stop a source through the control UI so `STOP_REQUESTED`, recorder quiescence and the immutable completion watermark are committed in order.

Only ingest or record streams when the operator has the required rights and the action complies with the source platform's terms. This development relay does not bypass access controls, DRM or geographic restrictions.

The OME monitor inside `worker-media` persists source online/offline state in PostgreSQL and writes a restart marker before the next recording is indexed. A recorder-file PTS reset opens a new `CaptureEpoch` but stays in the current playback discontinuity; only an observed source restart, time-base/timestamp discontinuity or real gap increments the playback discontinuity. Verify a captured spool with actual ffprobe sample tables:

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

Use a maintenance window. Stop new capture/annotation writes and pause `worker-media` and `worker-workflow` before starting a cross-store backup. A database dump and object mirror are not one atomic transaction, so record the start/end time and retain both artifacts as one backup set.

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
