# ADR 0054: OME RTMP push sources per match

## Status

Accepted — 2026-08-19

## Decision

Each RTMP source is a server-created `CaptureSession` with `sourceKind=rtmp`.
The server generates a 192-bit URL-safe stream key, uses that key as the OME
stream name, and returns both the operator-facing RTMP URL and stream key.
`OME_RTMP_PUBLIC_URL` supplies the host/port reachable by the encoder; the
server appends the generated key.

The worker does not pull or relay RTMP. It waits for OME's stream monitor to
observe the key, while OME owns RTMP ingest, LL-HLS/DVR, and FILE recording.
When the stream goes offline, the existing recording catalog/index pipeline
drains the finalized OME files. The existing 60-second physical recording
extent remains independent from the two-second LL-HLS segment duration.

The key is persisted as the capture's opaque ingest path so a permitted
operator can retrieve the current source credentials after a page reload. The
readback route is restricted to administrators or operators who are members
of the match. There is no public OME API or browser media proxy in this path.

## Consequences

- OBS, mobile encoders, and cameras can push directly to OME without a second
  relay or a Node video-byte path.
- OME stream presence is the live readiness signal; recording finalization is
  asynchronous and does not delay live capture promotion.
- A future key rotation can be implemented by stopping the capture and
  creating a new source; this first slice intentionally has one active source
  per match, matching the existing capture lifecycle invariant.

## Verification

- API unit test verifies generated key shape, OME URL construction, and durable
  `rtmp` work scheduling.
- Worker unit test verifies RTMP does not spawn a relay process and is
  cancellable while waiting for an external source.
- Compose config validation verifies the public RTMP URL reaches the server.
