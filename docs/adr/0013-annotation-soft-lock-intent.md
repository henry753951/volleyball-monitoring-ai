# ADR 0013: Annotation Realtime 2.1 soft-lock intent

- Status: Accepted
- Date: 2026-08-08
- Decision owner: Main PM / Tech Lead

## Context

Annotation Realtime 2.0 already exposes `presence_snapshot.members[].editing_key_point_id`, while the server always publishes `null` because no strict client intent exists. The workstation can move draft key points through authoritative frame-step and `MOVE_KEY_POINT`, but collaborators cannot see that another device is actively dragging or fine-tuning the same marker.

Soft locks are advisory only. They must never become PostgreSQL state, a prerequisite for MOVE, a replacement for Rally revision/CAS, or a source of media time/frame truth.

## Decision

1. The public Annotation Realtime registry advances additively to `2.1.0`. Every canonical Rally command, ACK, rejection and server snapshot retains its existing `2.0.0` envelope and semantics. Existing 2.0 command consumers remain valid.
2. Add one strict client-only message:

   ```json
   {
     "schema_version": "2.1.0",
     "type": "soft_lock_intent",
     "room_id": "match:...:capture:...",
     "editing_key_point_id": "... or null"
   }
   ```

   It contains no command ID, Rally ID, revision, playback cursor or identity. Authentication, user and device session come only from the authorized WebSocket connection.

3. The server stores the hint in the existing Redis presence hash with an independent 12-second expiry and publishes the existing strict `presence_snapshot`. The client refreshes an active hint every five seconds and sends `null` on release/disconnect. A server expiry timer publishes a clearing snapshot even if the release message is lost.
4. A remote hint changes presentation only. The marker remains selectable/draggable, the server still accepts concurrent MOVE attempts, and ordinary serializable revision/CAS conflict handling decides canonical state.
5. A drag target is only navigation intent. The workstation opens a bounded archive window, waits for a real browser frame observation and asks the server to resolve it before sending the unchanged `MOVE_KEY_POINT` command. Timeline pixel position never becomes an authoritative anchor.

## Consequences

- No Prisma migration, durable receipt, GraphQL field, external AI contract or Python SDK change is introduced.
- Disconnect, TTL and Redis loss safely remove hints without changing canonical data.
- Multiple remote devices may advertise the same key point; the UI lists all display names and does not choose a lock owner.
- Contract fixture/parser tests, presence expiry tests, WebSocket transport tests, marker drag tests and a two-browser runtime check are required before this decision is considered implemented.
