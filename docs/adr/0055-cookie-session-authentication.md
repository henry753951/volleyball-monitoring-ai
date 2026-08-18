# ADR 0055: Single-account browser authentication

## Status

Accepted for the first deployed login slice.

## Decision

The browser-facing application uses one environment-configured application account and an
HTTP-only, signed session cookie. The configured account is materialized as a single `User`
with `ADMIN` identity and a durable `DeviceSession`; match membership checks therefore remain
compatible with the existing domain code while the account has complete application access.

The server exposes:

- `POST /api/v1/auth/login`
- `GET /api/v1/auth/session`
- `POST /api/v1/auth/logout`

The session token is HMAC signed, expires after the configured TTL, and is checked against the
non-revoked `DeviceSession`. Passwords and the session secret are deployment secrets, never
stored in Prisma or committed to the repository.

All browser-facing REST routes, GraphQL, annotation WebSocket, coach WebSocket, media playback,
media cursor, operations, and media-source routes use this identity resolver. Health probes,
OME/container endpoints, the AI provider WebSocket, and provider callback tokens remain separate
because they are service-to-service contracts and must not depend on a browser cookie.

Development `x-dev-*` identity headers remain available only when `DEV_AUTH_ENABLED=true` and
the process is not production. They are a test/local compatibility path, not production login.

## Configuration

The deployment supplies `APP_AUTH_USERNAME`, `APP_AUTH_PASSWORD`, and
`APP_AUTH_SESSION_SECRET`. The local `.env` uses the single account requested for this instance;
the repository example contains placeholders only. `OME_RTMP_PUBLIC_URL` is configured as
`rtmp://rtmp-volley-ai.hsulab.net:2035/app` to match the current Compose RTMP host port.

## Consequences

This slice deliberately does not introduce user self-registration, role administration, or
password change APIs. Changing the account is an internal deployment-secret change followed by
a server restart; changing the session secret invalidates existing browser sessions.
