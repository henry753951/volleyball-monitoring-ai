
# Public contracts

This directory is owned by the main agent and the contracts/SDK worker. Consumers must not
invent fields outside these versioned files.

## Boundaries

- `media/playback-window-request.schema.json` / `playback-window-extend-request.schema.json` / `playback-window-descriptor.schema.json`: create and append to one bounded live/archive HLS window without changing its manifest identity.
- `media/playback-cursor.schema.json` / `resolved-media-anchor.schema.json`: client observation and authoritative server result.
- `media/frame-step-request.schema.json` / `canonical-frame-anchor.schema.json`: previous/next canonical sample.
- `annotation/realtime.schema.json`: breaking v2.0 Z/Space/CLOSE_RALLY/edit/Enter commands and strict ACK/reject/snapshot messages. CLOSE_RALLY carries the target last key point plus a resolved-left/resolved-right/unknown rally outcome and no new timestamp.
- `ai/capabilities.schema.json`, `job.schema.json`, `job-accepted.schema.json`: provider handshake and immutable job submission.
- `ai/result.schema.json`: external AI provider to central result JSON.
- `ai/callback.schema.json`: progress/failure/completed callback metadata.
- `ai/provider-realtime.schema.json`: outbound AI worker control plane for hello, job offer, lease/resume, progress and abort. Media and full overlays are forbidden on this channel.
- `ai/overlay-manifest.schema.json`: central-to-web lazy overlay manifest.
- `flatbuffers/*.fbs`: per-frame AI/coach overlay binary.
- `openapi/*.yaml`: REST route documentation.
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

Personal-computer providers should use Provider Realtime `1.0.0`: the SDK opens an outbound WSS
connection and waits for central job control. The existing Job `1.1.0`, Result `1.0.0` and Callback
`1.0.0` payloads remain unchanged. WSS is control-plane only; the canonical MP4 uses its signed URL
and completed analysis/overlay use the authenticated callback.
