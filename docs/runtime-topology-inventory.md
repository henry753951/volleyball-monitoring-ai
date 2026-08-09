# Runtime topology inventory before simplification

Snapshot date: 2026-08-09
Source: `infra/compose.yaml` rendered with `.env.example` and all profiles enabled.

This is the Phase 1 removal ledger for ADR 0024. It records names and configuration surfaces, not
secret values.

## Current Compose services

| Service | Profile | Image/build | Published ports | Persistent/bind mounts | Disposition |
|---|---|---|---|---|---|
| `postgres` | base | `postgres:17-alpine` | `5433:5432` | `postgres-data` | keep |
| `redis` | base | `redis:8-alpine` | none | `redis-data` | keep |
| `minio` | base | `quay.io/minio/minio` | `9000`, `9001` | `minio-data` | keep |
| `minio-init` | base, one-shot | `quay.io/minio/mc` | none | none | replace with host bootstrap |
| `ovenmediaengine` | base | `ovenmedialabs/ovenmediaengine:v0.20.5` | `1935/tcp`, `9999/udp`, `8081/tcp` | OME config, `media-spool`, `ome-dvr`, `ome-logs` | keep |
| `traefik` | base | `traefik:v3.7.9` | `80`, `443`, `8080` | Docker socket, Traefik config/certs | keep; optional in daily dev |
| `server` | `app` | `infra/docker/server.Dockerfile` | `4000` | `media-imports`, `media-spool` | keep |
| `web` | `app` | `infra/docker/web.Dockerfile` | routed | none | keep |
| `worker-media-indexer` | `app` | `infra/docker/worker.Dockerfile` | none | `media-spool` | fold into `worker-media` |
| `ome-recording-watcher` | `app` | `python:3.12-alpine` | none | watcher script, `media-spool`, `ome-watcher-state` | fold into `worker-media` |
| `youtube-relay` | `app` | `infra/docker/youtube-relay.Dockerfile` | none | imports/state/work/recordings | fold into `worker-media` |
| `worker-clip` | `app` | `infra/docker/worker.Dockerfile` | none | `media-spool` | fold into `worker-workflow` |
| `worker-playback` | `app` | `infra/docker/worker.Dockerfile` | none | `media-spool` | fold into `worker-workflow` |
| `worker-analysis-ingest` | `app` | `infra/docker/worker.Dockerfile` | none | `media-spool` | fold into `worker-workflow` |
| `worker-outbox` | `app` | `infra/docker/worker.Dockerfile` | none | `media-spool` | fold into `worker-workflow` |
| `worker-ai-dispatcher` | `app` | `infra/docker/worker.Dockerfile` | none | `media-spool` | remove after WS-only cutover |
| `tracking-replay-provider` | `dev-ai` | `infra/docker/tracking-replay-provider.Dockerfile` | none | external Contract Lab handoff | remove after external-engine E2E |

Current count is seventeen services: eleven in the base/`app` deployment plus six additional app
workers/adapters and the optional replay profile. The target is nine fixed central containers.

## Current named volumes

Keep: `postgres-data`, `redis-data`, `minio-data`, `media-imports`, `media-spool`, `ome-dvr`,
`ome-logs`.

Remove after migration: `media-source-state`, `media-source-work`, `ome-watcher-state`.

## Current Dockerfiles

| File | Target state |
|---|---|
| `infra/docker/server.Dockerfile` | keep |
| `infra/docker/web.Dockerfile` | keep |
| `infra/docker/worker.Dockerfile` | keep; produce the two composed worker services |
| `infra/docker/youtube-relay.Dockerfile` | remove after media-worker parity |
| `infra/docker/tracking-replay-provider.Dockerfile` | remove after external-engine E2E |

## Environment-variable ownership

### Core infrastructure and application

- PostgreSQL/Redis: `DATABASE_URL`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`,
  `POSTGRES_HOST_PORT`, `REDIS_URL`.
- Object storage: `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_RAW_BUCKET`,
  `MINIO_DVR_BUCKET`, `MINIO_RALLY_BUCKET`, `MINIO_ANALYSIS_BUCKET`, `MINIO_HOST_PORT`,
  `MINIO_CONSOLE_HOST_PORT`.
- OME: `OME_API_URL`, `OME_API_ACCESS_TOKEN`, `OME_HOST_IP`, `OME_DVR_MAX_DURATION`.
- Server/Web: `PORT`, `SERVER_DEV_BIND`, `SERVER_DEV_PORT`, `WEB_ORIGIN`, `NODE_ENV`,
  `DEV_AUTH_ENABLED`, `DEV_USER_ID`, `DEV_USER_DISPLAY_NAME`, `DEV_USER_ROLE`,
  `NUXT_PUBLIC_GRAPHQL_PATH`, `NUXT_PUBLIC_REST_BASE_PATH`, `NUXT_PUBLIC_ANNOTATION_WS_PATH`,
  `NUXT_PUBLIC_COACH_WS_PATH`, `NUXT_PUBLIC_LIVE_HLS_BASE_PATH`,
  `NUXT_PUBLIC_COACH_EMBED_URL`.
- DVR/clip: `DVR_SEGMENT_DURATION_SECONDS`, `DVR_PLAYBACK_WINDOW_BACK_SECONDS`,
  `DVR_PLAYBACK_WINDOW_FORWARD_SECONDS`, `DVR_CLIENT_BACK_BUFFER_SECONDS`,
  `DVR_CLIENT_MAX_BUFFER_SECONDS`, `CLIP_PRE_ROLL_SECONDS`, `CLIP_POST_ROLL_SECONDS`,
  `MEDIA_SPOOL_DIR`, `MEDIA_RECORDING_ROOT`, `MEDIA_IMPORT_ROOT`, `MEDIA_UPLOAD_MAX_BYTES`.
- External AI kept after migration: `AI_CALLBACK_TOKEN_SECRET`, `AI_PROVIDER_BEARER_TOKEN`,
  `CALLBACK_PUBLIC_BASE_URL`.
- Development fixture paths: `CONTRACT_LAB_ROOT`, `CONTRACT_LAB_HANDOFF_PATH`,
  `CONTRACT_LAB_DVR_SPOOL_PATH`.

### Variables to replace or remove

- Internal indexer hook: `MEDIA_INDEXER_HOOK_BIND`, `MEDIA_INDEXER_HOOK_PORT`,
  `MEDIA_INDEXER_HOOK_TOKEN`, `MEDIA_INDEXER_HOOK_URL`, `MEDIA_INDEXER_SCAN_INTERVAL_MS`.
- OME watcher state: `OME_WATCHER_STATE_PATH`.
- Media gateway/relay: `MEDIA_SOURCE_GATEWAY_URL`, `MEDIA_SOURCE_GATEWAY_TOKEN`,
  `MEDIA_SOURCE_CALLBACK_URL`, `MEDIA_SOURCE_CALLBACK_TOKEN`, `MEDIA_SOURCE_STATE_ROOT`,
  `MEDIA_SOURCE_WORK_ROOT`, `MEDIA_INGEST_BASE_URL`, `YOUTUBE_EXTRACTOR_ARGS`, `YOUTUBE_FORMAT`,
  `YOUTUBE_VOD_MAX_STALL_ATTEMPTS`.
- HTTP AI adapter: `AI_PROVIDER_CAPABILITIES_URL`, `AI_PROVIDER_SUBMIT_URL`.
- Per-container role selection: `WORKER_ROLE`; replacement processes have explicit composed
  entrypoints instead of one environment-selected legacy role.

YouTube extractor/format/stall policy remains a media-worker setting even though the old
gateway-prefixed variables and process boundary are removed. The Phase 3 implementation will give
those retained settings worker-owned names rather than silently dropping them.

### New variables

- `OBJECT_STORAGE_BOOTSTRAP_MODE=ensure|validate`.
- Per-module concurrency, poll/backoff and FFmpeg limits under the two composed worker namespaces.
  Exact names are introduced with their implementation and documented in `.env.example`.

## Database transport audit

The live development database contained one integration at this snapshot:

| Integration | Transport | Enabled | HTTP URLs | Active queued/running jobs |
|---|---|---:|---|---:|
| `volleyball-analysis-engine` | `WS_AGENT` | yes | both null | 0 |

No `HTTP_PUSH` integration row existed. This allows the Phase 4 enum/column migration after the
external engine passes the end-to-end gate; it is not permission to remove historical evidence
before that gate.

## Preserved baseline evidence

- Media package: 88 tests passed.
- Focused Server media/sample-index/PTS paths: 38 tests passed.
- Focused Worker clip/indexer/resolver paths: 16 tests passed.
- PR #54 full CI passed GraphQL schema generation, Prisma migration, repository validators,
  TypeScript, DB/Server tests, all remaining package tests and production builds.
- DEMO browser acceptance retained canonical DVR playback, one completed analysis rail, analysis
  review access, green browser-buffer ranges, ruler seeking and exact server reconciliation after
  optimistic 60 fps frame stepping.

The external `volleyball-analysis-engine` WS receive/callback E2E remains the final Phase 1 gate
before destructive AI cleanup.
