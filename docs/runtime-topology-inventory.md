# Runtime topology migration inventory

Snapshot date: 2026-08-09
Authority: ADR 0024 and `infra/compose.yaml`.

This ledger tracks the simplification from the Phase 1 baseline to the current branch. Retired
service names remain only in the superseded ADR/history and migrations.

## Current Compose services

| Service | Profile | Persistent state | Disposition |
|---|---|---|---|
| `postgres` | base | `postgres-data` | keep |
| `redis` | base | `redis-data` | keep |
| `minio` | base | `minio-data` | keep |
| `ovenmediaengine` | base | host-bound recording spool, OME data/logs | keep |
| `traefik` | base | certificates/config | keep; optional in daily development |
| `server` | `app` | shared imports/spool | keep |
| `web` | `app` | none | keep |
| `worker-media` | `app` | shared imports/spool; PostgreSQL jobs | keep |
| `worker-workflow` | `app` | PostgreSQL/MinIO | keep |

The Phase 2 through Phase 5 runtime consolidation is complete in source and Compose. The central
`app` profile contains exactly the fixed target of nine services. Bucket provisioning is a host
command and does not create a stopped one-shot container in Docker Desktop.

## Current persistent paths and named volumes

Keep named volumes: `postgres-data`, `redis-data`, `minio-data`, `ome-dvr`, `ome-logs`.
Media imports and the OME recording spool are bind-mounted from `.data/runtime` by default so the
same files are visible to host Bun workers and full-profile containers. Production may replace the
defaults with absolute `MEDIA_IMPORT_HOST_PATH` and `MEDIA_SPOOL_HOST_PATH` values.

Media source desired state, leases, retries, reconnect observations and completion watermarks now
live in PostgreSQL. There is no dedicated relay/watcher state volume.

## Current Dockerfiles

| File | Target state |
|---|---|
| `infra/docker/server.Dockerfile` | keep |
| `infra/docker/web.Dockerfile` | keep |
| `infra/docker/worker.Dockerfile` | keep; builds both composed workers and installs uv-managed `yt-dlp` |

## Environment-variable ownership

### Core infrastructure and application

- PostgreSQL/Redis: `DATABASE_URL`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`,
  `POSTGRES_HOST_PORT`, `REDIS_URL`, `REDIS_HOST_PORT`.
- Object storage: `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`,
  `MINIO_RAW_BUCKET`, `MINIO_DVR_BUCKET`, `MINIO_RALLY_BUCKET`,
  `MINIO_ANALYSIS_BUCKET`, `MINIO_BOOTSTRAP_ENDPOINT`,
  `OBJECT_STORAGE_BOOTSTRAP_MODE`, `OBJECT_STORAGE_BOOTSTRAP_TIMEOUT_MS`.
- OME: `OME_API_URL`, `OME_API_ACCESS_TOKEN`, `OME_HOST_IP`, `OME_DVR_MAX_DURATION`.
- Media worker: `MEDIA_SPOOL_DIR`, `MEDIA_IMPORT_ROOT`, `MEDIA_SOURCE_WORK_ROOT`,
  `MEDIA_INGEST_BASE_URL`, `MEDIA_INDEXER_SCAN_INTERVAL_MS`,
  `MEDIA_SOURCE_CONCURRENCY`, `MEDIA_SOURCE_POLL_INTERVAL_MS`, `YOUTUBE_FORMAT`,
  `YOUTUBE_EXTRACTOR_ARGS`, `YT_DLP_COMMAND`, `MEDIA_SPOOL_HOST_PATH`,
  `MEDIA_IMPORT_HOST_PATH`, `WORKER_MEDIA_HEALTH_PORT`.
- Workflow worker: `WORKER_WORKFLOW_HEALTH_PORT`; individual module concurrency/backoff remains
  owned by its module rather than a shared failure loop.
- Server/Web: `PORT`, `SERVER_DEV_BIND`, `SERVER_DEV_PORT`, `WEB_ORIGIN`,
  `DEV_AUTH_ENABLED`, `DEV_USER_ID`, `DEV_USER_DISPLAY_NAME`, `DEV_USER_ROLE`,
  and the documented `NUXT_PUBLIC_*` URLs.
- DVR/clip: playback-window, client-buffer and clip-roll settings remain unchanged.

### Storage bootstrap

- `bun run storage:bootstrap` is idempotent. `ensure` creates only missing local-development buckets;
  `validate` performs read-only production verification and fails when any required bucket is absent.
- `bun run dev:infra` starts only PostgreSQL, Redis, MinIO and OME, then performs `ensure`.
- `bun run dev:https` adds Traefik without moving Server, Nuxt or workers back into containers.
- `bun run dev` supervises Server, Nuxt and both workers on the host. The host mapping changes only
  infrastructure endpoints; the existing Nuxt/API/GraphQL/REST/WebSocket interfaces are preserved.

## Database transport audit

The development database has one enabled `WS_AGENT` integration, no HTTP integration and no
queued/running legacy delivery jobs. The external engine also completed a real persisted job and
callback. Phase 4 removed the central dispatcher and replay runtime without changing the working
Nuxt, GraphQL, REST, Annotation WebSocket or AI Worker WebSocket interfaces. Compatibility columns
remain in Prisma for now so this runtime-only cleanup does not force an unrelated public migration.

## Preserved verification evidence

- Phase 1: media 88 tests; focused Server media/sample/PTS 38; focused Worker paths 16.
- Phase 2: Worker 169 passed, 6 skipped; build/typecheck and a real PostgreSQL lifecycle smoke.
- Phase 3: Server 221 passed; Worker 162 passed, 6 skipped; local FFmpeg MP4 segmentation smoke;
  PostgreSQL lease/CAS and zero-segment drain smoke; Compose renders one `worker-media`; the 339 MB
  worker image starts Bun 1.3.14, yt-dlp 2026.07.04 and FFmpeg 6.1.2.
- Phase 5: Compose renders exactly nine services; host `ensure` and read-only `validate` both passed
  against the running MinIO, and the bootstrap unit suite passed 4 cases.
- Phase 6: normal development runs exactly four project Docker containers; the isolated host smoke
  reached Server, Nuxt and both component-aware worker readiness endpoints, then released all test
  ports. Optional Traefik successfully routed the unchanged HTTPS root to the existing host Nuxt.
