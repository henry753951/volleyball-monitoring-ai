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
- `CourtSideSwapMarker` stores one absolute left/right boundary anchored to the selected rally ID.
  It never stores a display ordinal and never rewrites a suffix of `Rally` rows.
- The server resolves all non-voided rallies by authoritative START capture time and applies the
  newest reached marker until another marker is reached. Repeating the action on the same rally
  removes that marker.
- Existing `CourtSideAssignment` and `Rally.sideAssignmentReversed` values remain migration input
  only when a match has no reached marker. Product reads do not expose their historical row count as
  court-side events.
- `Rally.scoringTeamId` is the point winner identity. The canonical projection maps that identity to
  the current left/right court side; changing sides never changes who won a previously marked point.
  Immutable submission snapshots, PTS, boundaries, key points, clips, and AI data are not changed.
- Newly created rallies inherit the latest marker reached by their START capture time, so a worker or
  browser refresh cannot silently revert the current court orientation.
- The annotation UI renders a swap marker only when adjacent canonical rallies actually change
  effective side order, including a change at a logical-set boundary.
- `MatchSet.winningRallyId` stores the stable rally that ended the set. Backfilling an earlier rally
  can renumber the visible list without detaching or moving the winner marker. Clearing a winner
  clears both `winningTeamId` and `winningRallyId`, but never deletes or rewrites rally annotations.
- Backend read models use `canonical-match-projection` as the sole source of displayed set number,
  rally number, score, winner marker, and left/right teams. Annotation, coach, replay, analytics, and
  generic Match GraphQL consumers render those values instead of recomputing them independently.

## Compatibility

Older clients that omit `effectiveFromRallyId` are accepted only when the supplied raw set and
ordinal resolve to an existing rally. A future ordinal that has no rally is rejected because it
cannot provide a stable product event anchor. New clients must send the rally ID.

## Required verification

- Scrambled raw ordinals with monotonic START PTS produce one marker transition.
- A later swap creates one later transition without moving or duplicating the first boundary.
- Stale rally IDs or side snapshots fail without partial updates.
- Coach and annotation projections agree on effective teams and scoring-team identity.
- Set-winner creation and removal persist and clear the stable rally anchor atomically.
- Inserting an earlier rally changes display numbering but not winner/swap marker identity.
