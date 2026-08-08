# ADR 0017: OvenMediaEngine ingest and stable MSE playback

Status: Accepted — 2026-08-09

## Context

The MediaMTX adapter and archive player both caused lifecycle churn. A bounded
archive window was emitted as a finished VOD playlist; near its end the browser
destroyed the HLS instance, cleared the video source and attached a new manifest.
That guarantees a visible rebuffer even when the next server segment is ready.

The canonical time model, sample indexes, immutable submission anchors and
server-side full DVR from ADR 0016 remain unchanged.

## Decision

### One streaming adapter

OvenMediaEngine is the only live ingest, LL-HLS and recording runtime. MediaMTX
configuration, image build, lifecycle hooks and environment variables are
removed. OME receives RTMP/SRT relays, exposes LL-HLS for live monitoring and
writes finalized recordings for the existing canonical indexer. OME health and
recording lifecycle are observable through its API and watcher.

YouTube Live uses yt-dlp only to resolve the upstream and FFmpeg only to relay it
to OME. YouTube VOD and uploaded MP4 still enter the server-owned capture/import
pipeline; source brand never becomes timeline authority.

### Stable archive playback

A `PlaybackWindow` has one stable ID, presentation origin and manifest URL for
its lifetime. The additive `PlaybackWindowExtendRequest 1.0.0` advances a
continuous rolling selection of ready canonical DVR segments for that same
window and bumps `mapping_version`. An overlapping suffix must remain identical;
the server may drop an already-buffered prefix and append only a new continuous
tail. `presentation_origin_capture_us` remains fixed even when
`window_capture_start_us` advances, so browser media time never jumps.

While a capture remains live, the manifest has a real media sequence and no
`EXT-X-ENDLIST`. Only a finished program whose bounded window reaches canonical
end may emit `ENDLIST`.

The Nuxt player attaches hls.js once. hls.js owns manifest reload, segment
prefetch/retry, MSE `blob:` attachment and browser-buffer eviction. Updating a
descriptor for the same window cannot destroy the HLS instance, clear `src` or
seek the video. The annotation page requests extension before the buffered edge;
authoritative frame resolution still uses server sample indexes.

### Failure behavior

Extension is serialized by database advisory lock and optimistic
`mapping_version`. A capture-epoch or init-map boundary is appended to the same
playlist with `EXT-X-DISCONTINUITY`; an actual gap, not-ready segment or changed
historical prefix fails closed. The client may create a different bounded window only for
an explicit random-access recenter, expiration or canonical boundary recovery.

## Compatibility

The extension request is additive contract version `1.0.0`; existing playback
descriptor `1.0.0` remains wire compatible. TypeScript parser, JSON Schema,
fixture, server, Nuxt consumer and Python SDK validator are updated together.

## Consequences

- MediaMTX is no longer a deployable or documented runtime option.
- Window extension does not switch the `<video>` source or recreate MSE.
- A rolling window may advance its active capture start past its fixed
  presentation origin after the browser has buffered that prefix.
- Full DVR remains server-side and browsers still receive bounded windows.
- OME and hls.js are transport/buffer engines, not canonical PTS authorities.

## Required verification

- OME config validation and 1920x1080 60 fps ingest, LL-HLS and recording smoke;
- CFR, 30000/1001, VFR, reconnect, PTS reset and gap sample-index tests;
- stable window ID/URL and monotonically appended manifest integration test;
- player regression proving same-window revisions do not replace the pipeline;
- YouTube VOD/live FHD60 source probing and local MP4 upload onboarding.

## References

- OvenMediaEngine: <https://github.com/OvenMediaLabs/OvenMediaEngine>
- OME LL-HLS: <https://docs.ovenmediaengine.com/0.17.2/streaming/low-latency-hls>
- OME recording: <https://ovenmedia.com/docs/ome/recording>
- hls.js API: <https://github.com/video-dev/hls.js/blob/master/docs/API.md>
