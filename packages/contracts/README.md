
# Public contracts

This directory is owned by the main agent and the contracts/SDK worker. Consumers must not
invent fields outside these versioned files.

## Boundaries

- `media/playback-window-request.schema.json` / `playback-window-extend-request.schema.json` / `playback-window-descriptor.schema.json`: create and append to one bounded live/archive HLS window without changing its manifest identity.
- `media/playback-cursor.schema.json` / `resolved-media-anchor.schema.json`: client observation and authoritative server result.
- `media/frame-step-request.schema.json` / `canonical-frame-anchor.schema.json`: bounded, batched previous/next canonical sample stepping with one authoritative response.
- `annotation/realtime.schema.json`: v3.0 uses canonical `START_RALLY`/`END_RALLY` boundaries. Z writes boundaries only; X creates optional manual contact key points. Score resolution no longer closes a Rally or gates submission.
- `ai/capabilities.schema.json`, `job.schema.json`, `job-accepted.schema.json`: provider handshake and immutable job submission.
- `ai/analysis-data-domain.schema.json`: domain JSON embedded inside the sole `VAD1` AnalysisData FlatBuffer. It contains tracks, contacts, paths, summaries and versioned extensions.
- `ai/reid-feature-bank-v1.schema.json`: optional `AnalysisData.extensions.reid_feature_bank` payload. It carries per-clip, per-court-side Sports OSNet prototypes and cannot-link evidence; central maps sides to immutable submission teams and owns match-scoped GIDs.
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
plan. Callback `2.0.0` uploads exactly one `VAD1` AnalysisData file. Analysis Review `1.3.0` stores
sparse human correction operations separately from immutable AI output. WSS is control-plane only;
the canonical MP4 uses its signed URL and completed AnalysisData uses the authenticated callback.
