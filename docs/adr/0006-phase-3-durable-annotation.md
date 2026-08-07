# ADR 0006: Phase 3 durable annotation commands and immutable submission

- Status: Accepted
- Date: 2026-08-07
- Decision owner: Main PM / Tech Lead

## Context

Phase 2A established server-side DVR, persisted sample indexes and authoritative
cursor/frame resolution. Phase 3 may now persist annotation state, but it must
not reintroduce browser-derived frame truth or the removed X/standalone
rally-end/score-frame workflow.

The checked Annotation Realtime JSON Schema already identifies itself as
`2.0.0`, while the TypeScript version registry still says `1.1.0` and no shared
runtime parser exists. The current `AnnotationOperation` row records accepted
draft mutations only; it cannot durably replay an identical ACK/rejection or
allocate a transport-wide `server_sequence` before a rally exists.

## Contract decision

1. Annotation Realtime `2.0.0` is the approved pre-release public contract.
   The TypeScript version registry, runtime types/parser, examples and tests
   must align to it. The schema may be strengthened in place before its first
   release; a later incompatible change requires a new version.
2. The fixed meanings remain Z service, Space contact, `<` left outcome, `>`
   right outcome, `?` unknown outcome and Enter immutable submit. There is no X
   command, standalone rally-end command, score event or score frame.
3. Service/contact ACKs contain the created key-point ID and non-null
   server-resolved anchor. `CLOSE_RALLY` ACK has no new anchor and identifies
   the terminalized existing key point plus rally-level outcome. Submit ACK has
   the immutable submission ID and no anchor.
4. All revision, PTS, capture-time, frame and server-sequence values are
   decimal strings on the wire and `bigint`/PostgreSQL `BIGINT` internally.
5. `room_id` is the canonical
   `match:<match-id>:capture:<capture-session-id>` string. The server parses it,
   verifies both IDs and membership, and never trusts it as an authorization
   decision by itself.

## Transport decision

- The dedicated endpoint remains `/ws/annotations`. The upgrade identifies
  `room_id` through the query string; authentication and device-session
  identity come from the same server request boundary used elsewhere. The
  first server message is `connection_ready` only after room authorization.
- WebSocket and GraphQL fallback invoke one annotation-command service. Pothos
  exposes `applyAnnotationCommand(command: JSON!): JSON!` only as a fallback
  transport; both input and output pass through the shared strict Realtime
  2.0.0 parser before domain code or clients consume them.
- An ACK/rejection is returned only after its receipt and any accepted domain
  mutation commit. Room broadcast happens after commit from a durable outbox;
  neither transport publishes optimistic canonical state.
- Media bytes and full overlays remain outside GraphQL and annotation WebSocket
  messages.

## Durable receipt and idempotency

Add a dedicated command-receipt table rather than weakening
`AnnotationOperation`:

- `serverSequence BIGINT` is an auto-incrementing primary key and is distinct
  from rally revision;
- `commandId` is globally unique, while `roomId`, `rallyId`, authenticated user
  and device session, canonical request hash/JSON, accepted flag and exact
  response JSON are retained;
- accepted commands also create the existing rally-scoped
  `AnnotationOperation`, linked to the receipt sequence;
- rejected commands can be retained even when the rally row does not exist.

The same command ID plus the same canonical request hash returns the stored
response byte-for-byte without another mutation or revision. Reusing an ID
with a different request returns a deterministic rejection. Known business
rejections commit a receipt with no partial domain writes. Unexpected
infrastructure failures roll back and do not fabricate an ACK.

## Transaction and authority boundary

1. Resolve a service/contact browser cursor through the existing media service
   before opening the annotation transaction. Never calculate canonical time or
   frame from browser `currentTime`, FPS or a client-provided anchor.
2. In a serializable transaction, take a transaction-scoped lock for the rally
   identity, revalidate room/capture/match/set/program/side-assignment
   relationships and compare `base_revision`.
3. Accepted mutation, revision, receipt, operation and outbox rows commit in one
   transaction. Bounded retries handle PostgreSQL serialization conflicts;
   concurrent commands with the same base revision cannot both succeed.
4. `CLOSE_RALLY` updates the current server-confirmed last key point to
   terminal and saves the rally-level left/right/unknown outcome atomically. It
   creates no key point and changes no persisted anchor.
5. Enter creates a new immutable `RallySubmission` and snapshot key points.
   Resolved outcomes create exactly one `PointAward`; unknown outcomes create
   none. Later correction creates a new draft/submission and never edits the
   immutable snapshot.

## First vertical slice

The first implementation PR is deliberately Z-only but end to end:

- align the 2.0.0 registry and add strict TypeScript parser/examples;
- add the receipt persistence/migration and server-sequence semantics;
- accept `CREATE_SERVICE_KEY_POINT` with `base_revision="0"` for a
  client-supplied rally UUID;
- resolve the supplied playback cursor through persisted media authority;
- create one OPEN rally and sequence-0 SERVICE key point, revision 1, accepted
  operation/receipt/outbox and exact ACK;
- expose the same handler through WebSocket and GraphQL fallback;
- return the stored ACK for an identical retry and reject stale/concurrent or
  same-ID/different-payload commands without partial rows.

All other 2.0.0 command kinds remain parseable but return a stable, durable
unsupported-command rejection until their next reviewed vertical slice. This
does not claim the Space/close/submit workflow is complete.

## PC workstation reconnect query

The Phase 3 workstation adds the nullable, authorization-filtered GraphQL
query `activeAnnotationRallySnapshot(roomId: String!): JSON`. This is an
additive field on the existing code-first GraphQL API, so no breaking contract
version is introduced. It returns only the same strict Annotation Realtime
2.0.0 `rally_snapshot` shape already consumed by the WebSocket client, selects
only OPEN/READY rallies for the exact match/capture room and exposes no media
or object-store identity. The stored GraphQL operation is the fixture and the
PC Web client is the sole new consumer; the external Python SDK/AI wire is
unchanged.

The coach PWA also consumes the additive, authorization-filtered
`coachMatchState(matchId: ID!): JSON` read model. Its versioned `1.0.0`
payload contains scoreboard, capture health and immutable
submission/processing summaries only; it returns no media bytes, storage
identity or mutable annotation rows. The stored GraphQL operation is the
fixture. This does not change the external AI or Python SDK contracts.

## Required evidence for the first slice

- JSON Schema and TypeScript parser positive/negative fixtures, including old
  X/v1/timestamp/score-frame payload rejection;
- isolated PostgreSQL tests for happy path, exact ACK replay, command-ID hash
  mismatch, concurrent base revision, rollback and no forbidden submission or
  point-award rows;
- cursor-not-ready, foreign room/capture and stale mapping failures create no
  rally/key point;
- WebSocket sender and GraphQL fallback return the same committed response;
- generated GraphQL SDL, Prisma migration, repository validators, full package
  tests, typechecks and builds pass before integration.
