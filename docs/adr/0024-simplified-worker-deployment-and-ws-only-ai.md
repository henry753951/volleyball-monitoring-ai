# ADR 0024: Simplified worker deployment and WS-only external AI

## Status

Accepted — 2026-08-09

Decision owner: Main PM / architecture integration agent

## Context

The current Compose application profile expands one central system into seventeen services. Eight
of them are process wrappers around related media or workflow loops, one is a deterministic replay
provider, and one is a one-shot MinIO initializer. This makes local development expensive and makes
container health look more fragmented than the underlying ownership model.

The outbound AI worker protocol from ADR 0016 is now the production direction. The development
database contains one enabled `WS_AGENT` integration and no `HTTP_PUSH` integration. Retaining the
HTTP dispatcher, provider HTTP probe fields and replay-provider container would preserve a second
control plane that the external `volleyball-analysis-engine` no longer needs.

This deployment simplification must not change media authority. OvenMediaEngine remains the sole
live transport/recording adapter; PostgreSQL sample indexes remain authoritative for capture time,
PTS and frame identity; immutable submissions remain the only clip/AI inputs; and full DVR remains
server-side.

## Decision

### Runtime topology

Daily host development runs PostgreSQL, Redis, MinIO and OvenMediaEngine in Docker. Traefik is
optional and is enabled only for HTTPS, WSS, PWA and production-like routing. Server, Nuxt,
`worker-media` and `worker-workflow` run as Bun host processes. External AI runs from its own
repository with `uv run volleyball-analysis-worker`.

The full central deployment has exactly nine long-running services: Traefik, PostgreSQL, Redis,
MinIO, OvenMediaEngine, Server, Web, `worker-media` and `worker-workflow`. AI workers are outbound
GPU clients and are not central deployment containers.

### `worker-media`

One Bun process composes independent YouTube source scheduling, OME relay control, OME recording
observation, ffprobe/sample-index creation and capture/DVR publication modules. Each module keeps
its own concurrency, metrics, retry/backoff and graceful shutdown boundary.

- Server persists media-source work; it does not call a process-private YouTube gateway.
- The media worker claims work with a PostgreSQL compare-and-set transition.
- OME recording observation invokes the indexer module in-process.
- Recording idempotency and watcher progress are persisted in PostgreSQL, not `watcher.json`.
- DVR assets continue through the S3-compatible MinIO boundary.

### `worker-workflow`

One Bun process composes clip production, playback-window cleanup, analysis convergence and outbox
publication. The four modules retain separate queues, polling intervals, concurrency limits,
metrics and failure isolation. FFmpeg subprocess concurrency is bounded and cannot block the
maintenance loops. Existing idempotency keys and database state transitions remain unchanged.

### WS-only external AI contract

AI workers connect outbound to `/api/v1/ai/providers/ws`. The server assigns work to the least-busy
eligible connected instance, sends a short-lived signed clip URL and keeps full media/results off
WebSocket. Completion continues through the bounded authenticated callback transaction.

Removing `AiTransportMode.HTTP_PUSH`, HTTP capability/submit URLs and the hosted provider adapter
is a breaking provider-configuration change. The registry/configuration contract becomes
WS-only `2.0.0`; Provider Realtime `1.0.0`, Job `1.1.0`, Result `1.0.0` and Callback `1.0.0` remain
wire-compatible. The pre-1.0 Python SDK advances from `0.3.x` to `0.4.0` when the hosted HTTP
provider helper is removed. The Prisma migration must rebuild the PostgreSQL enum rather than
leaving an unreachable value.

The migration is allowed only while no enabled or queued work references `HTTP_PUSH`. Historical
migrations and this ADR may retain the literal as evidence; executable code, active configuration,
product documentation and UI must not.

### Object-storage bootstrap

`minio-init` is replaced by an idempotent host command. `OBJECT_STORAGE_BOOTSTRAP_MODE=ensure`
creates missing development buckets; `validate` only verifies production prerequisites and does
not require create-bucket permission.

### Health and operations

Container liveness does not collapse module health. `worker-media` and `worker-workflow` expose one
aggregate status plus named loop heartbeats, active work, backlog, queue latency, last success and
secret-free errors. Loss of indexing or clip production is unhealthy; loss of a maintenance loop is
degraded and does not restart unrelated loops. The control console continues to show subsystems
individually.

## Migration sequence

1. Record the current topology, database transport state and reconnect/sample-index/clip baselines.
2. Compose the four workflow modules and remove their four legacy Compose services.
3. Compose media source, OME observation and indexing; replace gateway/hook/state-file paths.
4. Prove the external AI engine end to end and then remove replay, dispatcher and HTTP contracts.
5. Replace `minio-init`, add local/HTTPS/full commands and update operations health.
6. Run contract, SDK, Prisma, media reconnect, frame/PTS, idempotency and full Compose gates; then
   scan executable/product surfaces for every retired literal.

Each step is independently revertible before the next destructive schema cleanup. Existing roles
remain deployable until their replacement process passes restart and duplicate-work tests.

## Consequences

- Daily development needs four base containers, or five with Traefik.
- Full central deployment has nine fixed containers.
- Process count is lower without weakening per-loop failure isolation or observability.
- There is one AI job control plane and no in-repository fake provider.
- Canonical DVR, sample-index, PTS, immutable submission and `court_pos` boundaries do not change.
