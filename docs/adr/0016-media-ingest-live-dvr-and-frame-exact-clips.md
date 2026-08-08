# ADR 0016: Media ingest, continuous Live DVR and frame-exact clips

Status: Accepted — 2026-08-08

## Context

The system already has a server-owned canonical timeline (`CaptureEpoch`, strict
sample indexes, DVR segments and bounded `PlaybackWindow`s), MediaMTX recording,
HLS.js playback and immutable submission anchors. Replacing the streaming layer
must not replace or weaken that time authority.

The existing clip worker did weaken it: it forced CFR with FFmpeg `-r` and then
derived output frame/PTS values from elapsed time and average FPS. That mapping
is not valid for VFR, dropped frames, irregular durations or timestamp
discontinuities.

## Decision

### Source orchestration

Introduce one application-level `MediaSource` lifecycle, scoped to exactly one
match, while allowing source adapters to use different transports:

- local upload: store the original object once, then import/index it directly;
  it must not be relayed through a streaming server and recorded again;
- YouTube VOD: use `yt-dlp` to download into the same import/index path;
- YouTube Live: use `yt-dlp`/FFmpeg only as the extractor/relay into the live
  ingest adapter;
- RTMP/SRT/RTSP/camera sources: enter through the live ingest adapter.

Playback, annotation, clip and AI consume only the canonical capture/session,
program and timeline interfaces. They do not branch on YouTube versus upload.
Stopping or deleting a match source ends its capture lifecycle; operations
queries are authorization- and match-scoped so historical test fixtures cannot
appear as another match's active input.

MediaMTX recorder files may restart their container-local PTS at every file
boundary. Each reset opens a new `CaptureEpoch` so source PTS remains truthful,
but a PTS reset by itself does not create a playback discontinuity. Only an
observed source restart, explicit timestamp/time-base discontinuity or real gap
increments the playback discontinuity. Source lifecycle hooks persist an
offline marker in the recorder spool before best-effort worker notification, so
periodic reconciliation remains sufficient after worker or network failure.

### Streaming layer

Keep MediaMTX as the current live ingest/recording implementation. It already
produces the fMP4 recordings consumed by the canonical indexer, so replacing it
before a compatibility test would create risk without removing the canonical
index requirement.

OME is an approved prototype candidate for the live adapter because LL-HLS Live
Rewind can provide a continuously reloaded playlist, disk-backed DVR and live
edge behavior. It is not a canonical frame authority. Promotion requires:

1. equivalent source lifecycle and reconnect/discontinuity signals;
2. retained actual sample PTS and stable access to recorded media;
3. successful synthetic CFR, 30000/1001, VFR, gap, reconnect and PTS-reset
   tests through the existing canonical indexer;
4. an explicit AGPL deployment review;
5. observably lower application-owned playlist/window churn.

This is an adapter replacement, not a parallel second canonical timeline.

### Live and archive playback

- Live playback uses one long-lived HLS.js/native player attachment and delegates
  playlist reload, retry, live edge and browser buffer eviction to that engine.
- Canonical DVR availability, browser `seekable` and browser `buffered` remain
  separate values. The full timeline comes from the server, never from
  `video.duration`, `seekable` or `buffered`.
- `PlaybackWindow` remains for bounded archive random access, exact sample
  resolution and historical annotation. It is not the live segment scheduler.
- Archive windows are prepared before a boundary and player transitions are
  mapped through canonical capture time. Browser media time is still only an
  observation.

### Frame-exact clip mapping

The clip worker now:

1. downloads and verifies each selected segment's strict sample-index artifact;
2. validates segment metadata, epoch, time base, source PTS, canonical frame and
   capture-time continuity;
3. snaps requested boundaries to actual source samples and identifies immutable
   key points by the complete source anchor;
4. selects video by source frame ordinal and preserves VFR timing with FFmpeg
   `fps_mode=passthrough`; no `-r`, time-times-FPS or average-FPS fallback is
   authoritative;
5. probes every produced video frame and requires the output frame count and
   monotonic PTS table to match the selected input sample count;
6. maps each key point to the actual probed output frame PTS and ordinal, failing
   closed when any identity cannot be proven.

The internal timing manifest is version `1.1.0` and records both immutable
source identity and actual clip identity. Public AI Job `1.1.0` remains
compatible: `key_point_id` identifies the immutable submission anchor and the
job carries its verified clip mapping. No second timing contract is introduced.
Coach analysis coverage reads this verified frame map; it does not convert an
AI frame range with average FPS.

### Processing and hardware acceleration

Remux/stream-copy is preferred whenever a provable source-to-output sample map
can be retained. The current canonical H.264/AAC profile still transcodes, but
does not coerce frame rate. Hardware acceleration is a deployment capability,
not business logic: workers may select a verified NVENC/QSV/VAAPI profile only
after startup capability probing, with a visible software fallback. Every path
must pass the same output-frame verification.

## Consequences

- OME is not introduced as a speculative second media stack.
- Local files and YouTube VOD avoid an unnecessary decode/stream/record loop.
- Continuous Live DVR can be improved independently of immutable annotation and
  clip/AI timing.
- A clip job may fail where the old implementation silently approximated. This
  is intentional; operators receive a timing failure rather than incorrect AI
  data.

## Required verification

- deterministic CFR, 30000/1001 and VFR sample tables;
- non-keyframe boundary, segment boundary and missing/duplicate output frame;
- gap, reconnect, PTS reset and time-base change rejection;
- Live → pause → rewind → archive → Go Live without destroying the live player;
- Frame N identity through submission, clip mapping, AI job, callback and
  overlay correlation.

## References

- OvenMediaEngine: <https://github.com/OvenMediaLabs/OvenMediaEngine>
- OME LL-HLS Live Rewind: <https://docs.ovenmediaengine.com/0.17.2/streaming/low-latency-hls>
- OME recording: <https://docs.ovenmediaengine.com/recording>
- MediaMTX recording: <https://mediamtx.org/docs/features/record>
- MediaMTX playback: <https://mediamtx.org/docs/features/playback>
- HLS.js API: <https://github.com/video-dev/hls.js/blob/master/docs/API.md>
