# Local operations runbook

This runbook covers the Docker Compose deployment in this repository. Run commands from the repository root. Load credentials from the ignored `.env`; never put MinIO credentials, callback tokens or database dumps in Git.

## Health and restart

The normal stack uses both profiles:

```powershell
docker compose --env-file .env -f infra/compose.yaml --profile app --profile dev-ai ps
docker exec volleyball-monitoring-ai-server-1 wget -qO- http://127.0.0.1:4000/health/ready
```

Restart stateful dependencies one at a time, waiting for `healthy` and Server readiness before continuing. A safe order is Redis, Server, workers, MinIO, PostgreSQL. Do not remove or recreate volumes during a restart drill. Afterward compare canonical row counts, an object SHA/byte length and all container restart counts to the pre-drill record.

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
