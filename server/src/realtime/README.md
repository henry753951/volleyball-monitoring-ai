
# Annotation realtime boundary

`/ws/annotations` carries only versioned messages from
`packages/contracts/annotation/realtime.schema.json`.

The WebSocket handler must call the same domain command handler as the GraphQL/REST
fallback. It must not mutate Prisma directly. The durable command transaction owns:

- command-id idempotency;
- base-revision compare-and-swap;
- playback-cursor resolution before creating/moving a key point;
- `CLOSE_RALLY` CAS validation using explicit `target_key_point_id` plus a strict rally-level resolved-left/resolved-right/unknown outcome, with no new time or score event;
- immutable submission creation on Enter;
- transaction outbox creation.

Redis may fan out presence and already-committed events, but PostgreSQL is authoritative.
