# ADR 0045: Server-side coach highlight exports

## Status

Accepted.

## Context

The coach player analytics page needs to combine the currently filtered action replays into one downloadable video. Coach users primarily use iPads, where browser-side decoding, Canvas composition, and re-encoding are expensive, inconsistent, and likely to be interrupted when Safari backgrounds the page.

The browser already receives bounded canonical clip references for each rally. Full DVR media must remain server-side, and binary media belongs on authenticated REST routes.

## Decision

The web client computes a source fingerprint from the selected subject, action filter, ordered event metadata, and every event's exact canonical `clipJobId`. It submits that fingerprint with the versioned `1.0.0` request. The server recomputes and verifies the fingerprint, authorizes the match, and resolves the clip IDs to READY media assets before creating an idempotent `CoachHighlightExportJob`.

The workflow worker downloads only the verified canonical clips, cuts a bounded window around every selected event, normalizes each segment to H.264/AAC MP4, and burns in the selected subject, set and rally number, and action label. It then concatenates the normalized segments and uploads a READY `HIGHLIGHT_REEL` media asset to the MinIO S3-compatible rally bucket under an immutable job-specific object key.

The client first looks up the current source fingerprint. A completed or active job is restored after reload without re-encoding; a changed analytics event set creates a new fingerprint and is exported only when the user requests it. Old versions and their authenticated links remain valid. The client polls active job progress and exposes the authenticated REST download only after completion. Leaving the page does not cancel the durable job.

## Consequences

- iPads only submit metadata, poll progress, and download the finished MP4.
- Export source selection remains deterministic even when a rally has older clip jobs.
- Continued analytics updates create explicit video versions instead of silently replacing an older reel.
- Generated MP4 objects and database records are retained by default; any future retention cleanup must delete the database reference and S3 object together.
- The workflow image must include FFmpeg and a CJK-capable font.
- Output authorization is scoped to the requesting user, with administrator override.
- Failed jobs can be retried through the same idempotent request.
