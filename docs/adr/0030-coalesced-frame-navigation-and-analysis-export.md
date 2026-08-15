# ADR 0030: Coalesced frame navigation and analysis export

Status: Accepted

## Context

Keyboard repeat and timeline gestures produced one REST request per frame or preview position. This degraded workstation responsiveness on lossy networks and could trigger burst-oriented firewall controls. Browser time remains observational, while canonical capture frame, PTS and time base must continue to come from the persisted sample index.

Operators also need a reproducible export of a processed rally without embedding credentials or asking the browser to buffer every MinIO object before creating an archive.

## Decision

- Frame step request `1.1.0` carries a required bounded `count` from 1 through 120. The server applies every adjacent step against the canonical sample index in one request and returns only the final canonical anchor.
- The annotation client previews repeated input locally. Short taps coalesce into one bounded
  authoritative step; a held player-navigation gesture sends bounded rolling batches so the browser
  keeps decoding and the canonical cursor advances before key release. Only the latest authoritative
  result is applied when the gesture settles. Key-point nudges remain coalesced and persist one
  annotation operation after canonical resolution.
- A direction gesture keeps one local owner (player or selected key point) from keydown through keyup,
  blur, or visibility loss. Transient seek/anchor recovery buffers input; a real gap still fails with
  an explicit reason. Crossing a playback-window boundary waits for the matching new mapping before
  applying the pending canonical anchor.
- Timeline preview never creates playback windows. A committed seek reuses the active, unexpired window when its mapping covers the target.
- Archive HLS manifests are sealed. A mapping revision explicitly reloads the stable archive URL; live manifests remain open and reload continuously.
- Dataset export is an authenticated server-streamed ML experiment bundle. It contains the unchanged canonical clip; redacted AI job input; authoritative result, overlay and timing manifest; every persisted analysis artifact; decoded per-frame player, ball, court-keypoint and action JSONL; immutable submission anchors; match/roster context; identity assignments; review corrections; normalized relational results; provider/job timing metadata; a data dictionary and per-file checksums. The browser only initiates the download.
- The raw overlay remains the lossless frame-by-frame source. Generated JSONL preserves exact quantized values beside decoded coordinates/confidence and joins frames by canonical frame index, clip time and capture time. Export fails closed when overlay and timing frame counts cannot be verified.
- Callback credentials are always redacted. Transient tensors, feature maps, embeddings, process memory and worker-local logs/previews are outside the online inference contract and are explicitly listed as excluded instead of being misrepresented as reproducible output.

## Consequences

- Held player navigation produces bounded rolling requests instead of one request per frame or one
  release-time jump. It preserves exact canonical ordering and PTS authority while allowing the video
  and cursor to visibly advance during the hold.
- Old frame-step request `1.0.0` is superseded; central server and web consumer must roll out together.
- ZIP generation streams MinIO objects and does not expose object-store credentials. The archive is not cached.
- Existing completed runs become ML-friendly without rerunning inference because the server deterministically decodes their persisted VOV1 overlay. The manifest distinguishes raw authoritative files, derived tables and non-persisted transient worker state.
