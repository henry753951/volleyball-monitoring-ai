# ADR 0058: Canonical rally anchors for set winners and court-side swaps

- Status: Accepted
- Date: 2026-08-20
- Decision owner: Main PM / Tech Lead
- Supersedes: ADR 0004 side-change ordering semantics

## Context

`CourtSideAssignment.effectiveFromRallyOrdinal` was introduced before the annotation workstation
supported winner-marker removal, logical-set merging, rally placement correction, and capture-time
display ordering. The raw `(setId, ordinal)` pair remains an append-only allocation key, but it is no
longer the product-visible order. Splitting assignment rows only by that key can therefore alternate
the effective teams many times when the same rallies are displayed in canonical media order.

Set winners have the same identity problem: the result belongs to the rally that ends the set, not
to whatever display ordinal that rally happened to have when the operator clicked the action.

## Decision

- A user court-side swap targets an existing rally. `SwapCourtSidesInput` adds the optional,
  backwards-compatible `effectiveFromRallyId`; current web clients always send it together with the
  legacy set ID and ordinal as a stale-selection guard.
- The server resolves all non-voided rallies in the match by authoritative START capture time and
  toggles the selected rally plus the complete canonical suffix. Raw ordinals never choose the
  affected media suffix.
- Existing `CourtSideAssignment` ranges remain the base assignment and backwards-compatible setup
  history. `Rally.sideAssignmentReversed` materializes the effective orientation needed to preserve
  earlier rallies and toggle the canonical suffix, even when old raw ordinals are interleaved.
- `Rally.scoringCourtSide` remains the human left/right result. The server rematerializes
  `Rally.scoringTeamId` from that result and the effective rally sides. Immutable submission
  snapshots, PTS, boundaries, key points, clips, and AI data are not changed.
- The newest raw assignment is aligned to the final effective rally orientation so newly created
  rallies and the next set inherit the current court sides.
- The annotation UI renders a swap marker only when adjacent canonical rallies actually change
  effective side order, including a change at a logical-set boundary.
- `MatchSet.winningRallyId` stores the stable rally that ended the set. Backfilling an earlier rally
  can renumber the visible list without detaching or moving the winner marker. Clearing a winner
  clears both `winningTeamId` and `winningRallyId`, but never deletes or rewrites rally annotations.

## Compatibility

Older clients that omit `effectiveFromRallyId` are accepted only when the supplied raw set and
ordinal resolve to an existing rally. The legacy future-ordinal path remains available for setup
compatibility but does not define canonical media ordering. New clients must send the rally ID.

## Required verification

- Scrambled raw ordinals with monotonic START PTS produce one suffix transition.
- A later swap creates one later transition without moving or duplicating the first boundary.
- Stale rally IDs or side snapshots fail without partial updates.
- Coach and annotation projections agree on effective teams and scoring-team identity.
- Set-winner creation and removal persist and clear the stable rally anchor atomically.
