# Public contracts

This directory is owned by the main agent and the contracts/SDK worker. Consumers must not
invent fields outside these versioned files.

## Boundaries

- `media/playback-window-request.schema.json` / `playback-window-extend-request.schema.json` / `playback-window-descriptor.schema.json`: create and append to one bounded live/archive HLS window without changing its manifest identity.
- `media/playback-cursor.schema.json` / `resolved-media-anchor.schema.json`: client observation and authoritative server result.
- `media/frame-step-request.schema.json` / `canonical-frame-anchor.schema.json`: bounded, batched previous/next canonical sample stepping with one authoritative response.
- `annotation/realtime.schema.json`: v4.0 keeps canonical `START_RALLY`/`END_RALLY` boundaries and adds human BallEvent kind/result/actor plus deterministic repair effects. Z writes boundaries only; X/C/V/B create or edit ordered ball events in both OPEN and READY until Enter creates the immutable submission. V/B persist generic `RECEIVE` success/error from ordinal 2 onward; consumers derive serve receive, spike receive, or ordinary receive from the immediately preceding canonical event instead of persisting another subtype. `SET_BALL_EVENT_ACTOR` assigns or clears an active match-roster actor without changing timing or invoking model work. Score resolution no longer closes a Rally or gates submission. Active ordinary drafts are device-session scoped; room broadcasts do not select another client's draft, and reconnect retries the same command id before refetch/rebase.
- `ai/capabilities.schema.json`, `job.schema.json`, `job-accepted.schema.json`: provider handshake and immutable job submission.
- `ai/provider-capabilities-v3.schema.json`, `provider-work-envelope.schema.json`, and
  `provider-work-realtime.schema.json`: capability-gated multi-work transport for `ANALYSIS`,
  `REID_FEATURE_EXTRACTION`, `REID_ASSOCIATION`, `IDENTITY_PREVIEW_GENERATION`, and explicit
  pose-evidence rebuild. The legacy analysis-only realtime/capabilities schemas remain readable
  during staged migration.
- `ai/provider-work-callback.schema.json`: idempotent generic progress/failure/completed callback
  metadata. Completed artifacts are named multipart parts with exact kind/schema/hash/size; callback
  authorization remains independent from every signed input URL.
- `ai/provider-analysis-job.schema.json`: base analysis request with court, tracking, contacts, and
  every-frame person pose only. ReID is deliberately absent and can never run inline through this
  request.
- `ai/analysis-evidence-manifest.schema.json`, `person-pose-evidence-manifest.schema.json`,
  `player-crop-source-manifest.schema.json`, and
  `flatbuffers/person-pose-evidence.fbs`: immutable every-canonical-frame/player pose evidence and
  bounded artifact manifests. Contact-time edits consume these artifacts and do not schedule model
  work.
- `analysis/review-*.schema.json`: Analysis Review `1.4.0` keeps sparse human edits separate from
  immutable AI output and exposes the latest durable pose-first actor projection independently from
  an explicit human actor override.
- `ai/reid-roster-snapshot.schema.json`, `reid-feature-job.schema.json`,
  `reid-feature-result.schema.json`,
  `reid-bank-snapshot.schema.json`, `reid-association-job.schema.json`, and
  `reid-association-result.schema.json`: independently rerunnable feature/association jobs with one
  explicit immutable roster input and eligible-history snapshot. Raw VLM responses remain a
  separately addressable artifact and are linked to each normalized jersey observation by key and
  hash; a later matcher never has to trust only a normalized jersey number. Bank snapshot `1.1.0`
  includes the immutable cluster/roster candidate index and each historical vector's artifact,
  byte range, dimension, metric, and model namespace; association workers never guess descriptor
  offsets from database-local state.
- `ai/identity-preview-job.schema.json` `1.1.0` and `identity-preview-result.schema.json` `1.0.0`:
  independently rerunnable animated player-crop previews. The job pins the central tracklet to its
  canonical analysis track ID, the saved pose manifest, canonical crop-source evidence, and an
  explicit frame list; it never reruns pose or alters identity evidence.
- `ai/analysis-data-domain.schema.json`: domain JSON embedded inside the sole `VAD1` AnalysisData FlatBuffer. It contains tracks, contacts, paths, summaries and versioned extensions.
- `ai/callback.schema.json`: progress/failure/completed callback metadata.
- `ai/provider-realtime.schema.json`: outbound AI worker control plane for hello, job offer, lease/resume, progress and abort. Media and AnalysisData bytes are forbidden on this channel.
- `ai/analysis-data-manifest.schema.json`: central-to-web lazy AnalysisData frame manifest.
- `flatbuffers/analysis-data.fbs`: authoritative AI result payload (`VAD1`); `analysis-frame-chunk.fbs` is the bounded browser projection (`VFC1`).
- `openapi/*.yaml`: REST route documentation.
- `GET /api/v1/analysis-runs/{analysisRunId}/dataset.zip`: versioned ML experiment bundle. It preserves the canonical MP4 and authoritative AnalysisData/timing artifacts, records source/cut/video metadata, adds separated per-frame/event/ReID JSONL plus human corrections, and redacts callback credentials.
- `graphql/schema.graphql`: generated from Pothos; never hand-edit.
- `fixtures/**`: golden examples that must validate in both JSON Schema and the Python SDK.

## 64-bit wire rule

PTS, microseconds, frame indices, revisions, byte lengths and counters that can exceed 32-bit
are decimal strings on JSON/GraphQL wire. PostgreSQL uses `BIGINT`; TypeScript internal code
may use `bigint`. Do not use JavaScript `number` for canonical values.

## Change protocol

A public change requires main-agent approval, version/compatibility decision, updated schema,
golden fixture, SDK model/validator, producer, consumer, generated artifacts and tests. Unknown
AI action labels or confidence semantics are not a reason to hard-code an enum.

## Authentication rule

The HTTP/WebSocket connection authenticates the user; annotation commands do not carry a trusted `user_id`. `clip.download_url` is independently signed. `callback.token` is sent only to the central callback URL and never to object storage or browsers.

## AI provider transport

Personal-computer providers use Provider Realtime `2.0.0`: the SDK opens an outbound WSS and waits
for central job control. Job `3.0.0` carries explicit segment boundaries and a full/selective module
plan. Callback `2.0.0` uploads exactly one `VAD1` AnalysisData file. Analysis Review `1.4.0` stores
sparse human correction operations plus versioned pose-first actor projections separately from
immutable AI output. WSS is control-plane only;
the canonical MP4 uses its signed URL and completed AnalysisData uses the authenticated callback.
