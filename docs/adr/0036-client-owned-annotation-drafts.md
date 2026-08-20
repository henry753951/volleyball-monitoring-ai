# ADR 0036: Shared editable annotation drafts with client-local control state

Status: Accepted

Date: 2026-08-14; amended 2026-08-20

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
  migration backfills old rows from their START boundary (or legacy service point). This field is
  origin and abandoned-draft recovery metadata, not mutation authorization.
- Any authenticated match member with `ADMIN`, `OPERATOR`, or `ANNOTATOR` authority may explicitly
  select and edit an unsubmitted `OPEN` or `READY` draft regardless of which device created it.
  Selecting a peer draft does not transfer or rewrite its owner field.
- Explicit selection makes the Rally this tab's remembered edit target. Its cursor, moving OPEN END
  preview, Z state, key-point selection and optimistic outbox remain tab-local; server revisions
  serialize durable changes. Merely receiving a room broadcast never activates an unrelated draft.
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
- Annotation snapshot and command paths do not own the media-source lifecycle. Selecting or editing a
  draft must never stop, complete, restart, or delete an active live capture.

## Compatibility and version decision

No annotation wire schema changes. Existing command, acknowledgement, identity, and revision fields
already express shared edits. This is a protocol-compatible workstation selection correction and a
clarification of the server's existing match-role authorization, so Annotation Realtime remains
`3.0.0`.

## Consequences

- A submitted Rally remains immutable and browser cursor observations remain non-authoritative.
- Explicit selection is the boundary between passive awareness and shared durable editing. Passive
  broadcasts cannot steal local control, and revision conflicts prevent silent concurrent overwrite.
  An abandoned owner can still be recovered during the WebSocket handshake before `connection_ready`,
  so reconnecting tabs restore their default active draft without a manual pick.
- A rejected overlap leaves the local READY draft intact and editable, so an operator can move the
  boundary/points or void it without reloading.
- Annotation collaboration cannot interrupt live recording because no annotation selection or
  command path invokes capture lifecycle controls.
