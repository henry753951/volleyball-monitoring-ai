# ADR 0030: Coalesced frame navigation and analysis export

Status: Accepted

## Context

Keyboard repeat and timeline gestures produced one REST request per frame or preview position. This degraded workstation responsiveness on lossy networks and could trigger burst-oriented firewall controls. Browser time remains observational, while canonical capture frame, PTS and time base must continue to come from the persisted sample index.

Operators also need a reproducible export of a processed rally without embedding credentials or asking the browser to buffer every MinIO object before creating an archive.

## Decision

- Frame step request `1.1.0` carries a required bounded `count` from 1 through 120. The server applies every adjacent step against the canonical sample index in one request and returns only the final canonical anchor.
- The annotation client previews repeated input locally, coalesces the net delta for 90 ms, then performs one authoritative step. Key-point nudges use the same rule and persist one annotation operation after canonical resolution.
- Timeline preview never creates playback windows. A committed seek reuses the active, unexpired window when its mapping covers the target.
- Archive HLS manifests are sealed. A mapping revision explicitly reloads the stable archive URL; live manifests remain open and reload continuously.
- Dataset export is an authenticated server-streamed ZIP containing the canonical clip, raw result, raw overlay, timing data, additional analysis artifacts, checksums, producer metadata and review corrections. The browser only initiates the download.

## Consequences

- Held navigation produces one request per settled burst instead of one request per frame while preserving exact frame ordering and PTS authority.
- Old frame-step request `1.0.0` is superseded; central server and web consumer must roll out together.
- ZIP generation streams MinIO objects and does not expose object-store credentials. The archive is not cached.
