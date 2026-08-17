# ADR 0036: Client-owned annotation drafts and READY contact editing

Status: Accepted

Date: 2026-08-14

## Context

Annotation snapshots are broadcast to every connection in a match/capture room. The workstation
previously treated any broadcast snapshot as its active draft, while the server also enforced one
ordinary `OPEN` Rally for the whole match. A second operator could therefore inherit another
operator's moving mask and make their next `Z` close that Rally. Lost acknowledgements could leave a
room-scoped local outbox waiting for manual confirmation, and `READY` incorrectly disabled contact
creation and editing even though the submission had not yet become immutable.

## Decision

- An ordinary draft stores its originating client explicitly in
  `Rally.draftOwnerDeviceSessionId`. New drafts assign the device session that creates START;
  migration backfills old rows from their START boundary (or legacy service point).
- `OPEN` is client-owned because its END preview and Z state are still moving local work. A peer
  inspection must stay read-only and must not replace that client's own OPEN draft.
- `READY` has a fixed authoritative END boundary. Any authorized operator who explicitly selects the
  unsubmitted READY draft may edit points, actors, ball events and outcome or submit it. Its cursor,
  key-point selection and optimistic state remain tab-local; server revisions serialize durable
  changes. Merely receiving a room broadcast never activates a READY draft in another tab.
- A reconnecting device of the same authenticated user may atomically recover exactly one abandoned
  `OPEN`/`READY` draft when its previous owner is absent from room presence. Recovery never steals
  from an online owner, never crosses users, and refuses ambiguous multiple candidates. It increments
  the Rally revision and records both an annotation operation and an outbox event.
- Room broadcasts remain useful invalidations and collaboration signals, but a client activates only
  its own restored draft, an explicitly selected Rally, or a snapshot for the Rally it is already
  displaying. An unrelated broadcast never changes the local Z state machine.
- The browser keeps its active Rally and durable command outbox in per-tab `sessionStorage`. Reloads
  retain the draft and pending commands; separate tabs do not share cursor or pending-command state.
- Pending commands record whether transmission was attempted. After reconnect the client first
  retries the exact command and idempotency key, then fetches/rebases with a new command id only after
  an authoritative revision conflict. Converged or obsolete operations are removed automatically
  instead of blocking all later commands.
- `END_RALLY` fixes the authoritative END boundary and changes the draft to `READY`; it does not make
  contact points immutable. `CREATE_CONTACT_KEY_POINT`, `MOVE_KEY_POINT`, and `DELETE_KEY_POINT`
  remain available in `OPEN` and `READY`. Only `SUBMIT_RALLY` creates the immutable submission.
- Parallel ordinary drafts may overlap while editable. Existing immutable submissions still block
  local boundary/edit commands, and submit performs a serialized authoritative overlap check so two
  overlapping drafts cannot both become active submissions.
- Key-point navigation is client-local and latest-wins. Its order is canonical capture time, then
  stable point id; loading another draft must select the exact requested point.

## Compatibility and version decision

No annotation wire schema changes. Existing v3 command and acknowledgement shapes already express
all operations and states. This is a protocol-compatible relaxation of when contact/edit commands
are accepted plus a client snapshot-selection correction, so Annotation Realtime remains `3.0.0`.
Older clients continue to work; they merely do not expose READY contact editing.

## Consequences

- A submitted Rally remains immutable and browser cursor observations remain non-authoritative.
- Device ownership prevents accidental cross-client closure without sending cursor state through the
  room. Explicitly selecting READY is the boundary between passive inspection and shared durable
  editing. An abandoned owner can still be recovered during the WebSocket handshake before
  `connection_ready`, so reconnecting tabs restore their default active draft without a manual pick.
- A rejected overlap leaves the local READY draft intact and editable, so an operator can move the
  boundary/points or void it without reloading.
