# ADR 0043: Contextual receive events and meaningful repair notices

Status: Accepted

Date: 2026-08-17

## Context

ADR 0038 constrained RECEIVE to ordinal 2 and rewrote later RECEIVE events to CONTACT. That model
cannot record a successful or failed defensive reception after an attack or an ordinary rally
contact. It also caused every newly created untyped keypoint to report `EVENT_KIND_NORMALIZED`, so
the UI announced 「已自動校正球點」 even when the server was only assigning the normal default for
the first time.

Persisting separate SERVE_RECEIVE, SPIKE_RECEIVE, and ordinary RECEIVE kinds would duplicate
sequence context and become stale whenever a point is inserted, moved, deleted, or tombstoned.

## Decision

- `RECEIVE` remains the only persisted receive kind.
- Ordinal 1 remains SERVE and ordinal 2 defaults to RECEIVE.
- Ordinal 3 and later may be CONTACT, SPIKE, or RECEIVE.
- V sets RECEIVE/SUCCESS and B sets RECEIVE/ERROR on any point from ordinal 2 onward. They are
  forbidden only on ordinal 1.
- A RECEIVE is projected as:
  - 「接發」when the immediately preceding canonical event is SERVE;
  - 「接殺」when the immediately preceding canonical event is SPIKE;
  - 「接球」otherwise.
- The projection is recomputed from canonical event order and is shared by the annotation timeline,
  selected-point editor, coach replay, court legend, and player analysis. No contextual subtype is
  written to PostgreSQL or the wire contract.
- RECEIVE/ERROR is displayed as 「失敗」. SERVE/ERROR remains 「失誤」.
- Submission validation accepts RECEIVE after ordinal 2 and returns one Chinese message that lists
  every unresolved event with ordinal, contextual name, and legal result choices.
- Server acknowledgements retain the complete repair audit. The web notification layer suppresses
  only `EVENT_KIND_NORMALIZED` repairs whose previous event is null, because those are first-time
  default initialization rather than a correction of user data. Real reordering, tombstoning,
  incompatible-result clearing, and inference repairs remain visible.

This decision supersedes ADR 0038 only where it restricted RECEIVE to ordinal 2, rewrote later
RECEIVE events to CONTACT, and treated first-time default initialization as a user-visible repair.

## Consequences

- Existing BallEvent schema version 4 remains valid; this is a hard semantic cutover without a new
  persisted enum or compatibility branch.
- Inserting or moving points automatically changes contextual labels without mutating the stored
  RECEIVE event.
- Analytics can separate serve receive, spike receive, and ordinary receive deterministically while
  retaining one stable low-level event kind.
- Audit consumers still see every server repair, while operators are notified only when their
  existing data was actually changed.
