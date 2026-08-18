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
- Pin smoke-tested yt-dlp nightly `2026.08.17.073947` (upstream `f1896c5`) and verify the
  official source archive SHA-256 during the image build. Pass each selected format's URL, HTTP headers and
  `downloader_options.http_chunk_size` to FFmpeg's bounded HTTP options (`request_size`,
  `initial_request_size`, `multiple_requests` and `short_seek_size`). Before starting FFmpeg,
  require HTTP 206 for a 64 KiB range at byte zero and at the next advertised chunk boundary
  for every selected track. A failed preflight is a bad resolver generation and triggers a
  fresh resolve; shrinking the chunk is only a secondary response to confirmed request-size rejection.
- Reset the no-progress retry budget whenever a new segment is committed. After the configured consecutive stall limit, report the source as failed instead of spinning forever.
- A finite VOD may emit the completion callback only when the committed two-second segment coverage reaches the declared source duration within `max(two segments, five seconds)`. A short successful ffmpeg exit is retryable and must not create `END`; VOD does not use generic `reconnect_at_eof`.
- The same checkpointed segmenter also makes local MP4 processing restart-safe. Active live ingest continues to use the existing live relay/reconnect lifecycle.

## Consequences

- Relay or host restarts resume near the last committed segment instead of downloading the complete prefix again.
- The server timeline can continue showing the full source extent separately from the growing server-available and browser-buffered ranges without falsely finalizing partial media.
- Capture checkpoint time follows the existing two-second DVR segmentation contract. Changing segment duration requires migrating both filename/checkpoint semantics together.
- `YOUTUBE_VOD_MAX_STALL_ATTEMPTS` controls consecutive retries without new durable progress and defaults to 20.
