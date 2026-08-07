# ADR 0010: Validated and windowed browser overlays

Status: Accepted — 2026-08-07

External AI continues to return one complete `VOV1` OverlaySequence. The central callback boundary now parses the FlatBuffer table, validates schema version, passthrough identity, clip video metadata, frame offsets and every structure-of-arrays column before activating an AnalysisRun. File identifier checks alone are insufficient.

The central server splits a valid sequence into fixed 120-frame `VOC1` chunks. Chunk metadata is durable in `OverlayManifest` and `OverlayChunk`; chunk bytes are immutable `OVERLAY_CHUNK` MinIO assets. The additive Central REST contract version is 1.3.0: authorized clients fetch `/api/v1/analysis-runs/:analysisRunId/overlay-manifest` and one chunk at a time. Storage bucket/object identity never crosses the REST boundary.

Browser replay retains only the current and next chunk and aborts obsolete requests after seek. It verifies byte length, SHA-256, file identifier, schema and manifest/chunk identity before drawing. JSON contact-event overlays remain an honest fallback when a historical AnalysisRun predates chunk materialization.

For Overlay v1, player flag bits are: `1` frame bbox, `2` frame foot position and `4` court position. Ball flag bit `1` means frame position is valid. Unknown bits are ignored. Confidence byte `255` represents missing, and action label ID `65535` represents missing. `court_pos` remains float32 and is never clamped or projected by central/frontend code.
