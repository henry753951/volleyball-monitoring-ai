# ADR 0021: Resumable VOD capture checkpoints

## Status

Accepted — 2026-08-09

## Context

YouTube VOD and completed-live sources can run for several hours. Their signed media URLs may expire or a relay container may restart before the source tail is reached. Re-reading from zero and merely suppressing already published files wastes bandwidth and can incorrectly publish a full source-duration `END` marker after only a short prefix was captured.

## Decision

- Treat the contiguous, atomically published DVR segment prefix as the durable capture checkpoint.
- Persist both the next segment index and its canonical capture-time offset in the relay state receipt.
- On restore or retry, seek every selected input to that offset and continue ffmpeg segment numbering from the same index. Existing objects are never overwritten.
- Re-resolve YouTube metadata before each retry so expired signed video/audio URLs are replaced.
- Reset the no-progress retry budget whenever a new segment is committed. After the configured consecutive stall limit, report the source as failed instead of spinning forever.
- A finite VOD may emit the completion callback only when the committed two-second segment coverage reaches the declared source duration. A short successful ffmpeg exit is retryable and must not create `END`.
- The same checkpointed segmenter also makes local MP4 processing restart-safe. Active live ingest continues to use the existing live relay/reconnect lifecycle.

## Consequences

- Relay or host restarts resume near the last committed segment instead of downloading the complete prefix again.
- The server timeline can continue showing the full source extent separately from the growing server-available and browser-buffered ranges without falsely finalizing partial media.
- Capture checkpoint time follows the existing two-second DVR segmentation contract. Changing segment duration requires migrating both filename/checkpoint semantics together.
- `YOUTUBE_VOD_MAX_STALL_ATTEMPTS` controls consecutive retries without new durable progress and defaults to 20.
