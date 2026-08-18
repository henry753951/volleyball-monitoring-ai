# ADR 0056: Persistent Chromium session for YouTube authentication

## Status

Accepted

## Decision

YouTube media resolution reads a persistent LinuxServer Chromium profile with
yt-dlp `--cookies-from-browser` for every resolver process. The profile is not
exported to a Netscape cookie file and raw cookie values are never stored in
PostgreSQL, configuration, logs, or browser-facing responses.

The browser is exposed only at the existing authenticated application host
under `/youtube-browser/`. Traefik forwards the current application session to
the server auth endpoint before proxying the LinuxServer HTTPS GUI. The
Chromium service remains ClusterIP-only.

The media worker mounts the profile read-only on the same Kubernetes node as
the browser because the current storage class is RWO. The profile path and
Chromium keyring mode are explicit configuration and must be verified against
the running container before claiming authentication is available. If that
mount/decryption arrangement cannot be verified, the next implementation must
use an in-pod authenticated resolver broker; it must not reintroduce a static
cookie export.

The existing bgutil provider, mweb extractor arguments, HTTP headers,
`http_chunk_size`, and FFmpeg bounded-range pipeline remain unchanged.

## Consequences

- Re-login and cookie rotation are picked up by the next fresh resolve or
  explicit health refresh without manual cookie export.
- Only opaque revision and timestamp metadata are persisted for diagnosis.
- The browser profile needs durable storage and the browser/worker pods are
  intentionally co-located while the PVC is RWO.
- Browser GUI access is protected by the existing application session, not a
  second Chromium Basic Auth account.
