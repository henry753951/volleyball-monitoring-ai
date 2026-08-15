# Architecture map

This document is the fast orientation layer for contributors and agents. Product rules remain authoritative in `SYSTEM_SPEC_V3_2.md`; wire details remain authoritative in `packages/contracts/`.

## Runtime topology

```text
Browser / iPad PWA
  -> Traefik
     -> Nuxt web
     -> Fastify server
        -> GraphQL Yoga + Pothos (domain reads/writes)
        -> REST (media, callbacks, binary/export payloads)
        -> dedicated WebSockets (annotation/review/coach revisions)
        -> PostgreSQL + Redis/pg-boss + MinIO/managed storage
     -> OME/HLS media paths

Media and workflow workers
  -> durable pg-boss jobs
  -> PostgreSQL state and sample indexes
  -> managed media storage

External AI provider
  <-> server provider WebSocket / Python SDK
  -> immutable submission analysis results
```

## Package ownership

| Area                  | Owns                                                                                         | Must not own                                   |
| --------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `web/`                | Nuxt routes, interaction state, bounded playback, visual overlays                            | authoritative media timestamps, AI model logic |
| `server/`             | authorization, domain transactions, GraphQL/REST/WS APIs, immutable submission orchestration | full media payload transport over GraphQL      |
| `worker/`             | media discovery/indexing, durable job execution, clip/workflow processing                    | user-facing domain policy                      |
| `packages/contracts/` | wire schemas, fixtures, validators, GraphQL snapshot/operations                              | runtime persistence behavior                   |
| `packages/db/`        | Prisma schema, migrations, generated client and Pothos types                                 | presentation logic                             |
| `packages/media/`     | canonical sample/time resolution and media primitives                                        | browser-only state                             |
| `sdk/`                | external provider client, serialization, fixture helpers                                     | AI model implementation                        |
| `infra/`              | local service topology and routing                                                           | production application semantics               |

## Data authority

- The browser playhead is advisory. `packages/media` and server resolution establish canonical capture time/frame.
- Annotation drafts are mutable only before immutable submission. Corrections create a new editable draft rather than editing history.
- Analysis tracks and actions are provider output. Central services may store and review them but do not invent missing model semantics.
- GraphQL schema is exported from Pothos code. `packages/contracts/graphql/schema.graphql` is a generated compatibility snapshot.
- Prisma schema and migrations are the database authority. Files under `packages/db/generated/` are generated output.

## Main flows

Detailed operator flows, current ReID behavior, the audited VLM/pose branch, and the accepted
annotation/ReID rearchitecture under implementation are maintained in
[`ANNOTATION_WORKSTATION_USER_FLOWS_AND_REID_EVOLUTION.md`](./ANNOTATION_WORKSTATION_USER_FLOWS_AND_REID_EVOLUTION.md).
The governing version/cutover decision is
[`ADR 0037`](./adr/0037-versioned-reid-evidence-and-provider-work.md).
The implemented job, evidence-generation, correction, rerun, preview, and later-clip bank behavior is
documented in
[`REID_EVIDENCE_AND_HUMAN_CORRECTION_GUIDE.md`](./REID_EVIDENCE_AND_HUMAN_CORRECTION_GUIDE.md).

### Annotation to analysis

1. Web resolves a bounded playback window and sends revisioned annotation commands over the annotation socket.
2. Server resolves canonical media anchors and updates the client-owned draft transactionally.
3. Enter creates an immutable `RallySubmission`.
4. Durable jobs create clips and send provider work.
5. Provider results bind to the immutable submission and become available to replay/analytics once complete.

### Media ingest

1. Media indexer waits for stable finalized files and enqueues strict-FIFO work per capture.
2. Worker probes samples, writes durable index/segment state, and retries bounded transient finalization failures.
3. Capture completion requires all expected non-gap segments to be READY; a quarantined failure never impersonates successful media.

### Coach replay

1. Coach queries select the latest completed analysis for an accessible immutable submission.
2. Optional review corrections are projected as effective events without mutating raw inference.
3. Web renders tracks, contacts, positions, heatmaps, and paths against the video/canonical court.

### Player identity

1. External AI results may include fixed-roster tracklet descriptors; Central currently associates
   them with match/team slots during callback activation.
2. Replay and analytics consume one effective Local/TID-to-roster assignment. GID/slot grouping is an
   aid and never replaces that run-local mapping.
3. Human decisions are forward-scoped or clip-local and preserve immutable AnalysisData. ReID is not
   yet an independently rerunnable workflow stage; do not describe automatic binding projection as a
   ReID rerun.

## Generated and synchronized files

- Run `bun run graphql:schema` after Pothos schema changes.
- Run `bun run graphql:codegen` after GraphQL operation/schema changes consumed by web.
- Run `bun run db:generate` after Prisma changes.
- Run `bun run checksums:refresh` after tracked source or documentation changes.
- `docs/SYSTEM_SPEC_V3_2.md` and `docs/MASTER_IMPLEMENTATION_SPEC.md` are intentionally separate named authorities even when largely synchronized; never overwrite one blindly from the other.
