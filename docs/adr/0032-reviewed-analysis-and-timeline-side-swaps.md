# ADR 0032: Reviewed analysis and segment side assignments

## Status

Accepted for the local product workflow.

## Decision

- Analysis corrections are optimistic local drafts. Frame, ball, player-box,
  action and contact edits are sent only when the operator chooses **Apply**.
- Applying corrections moves the analysis to `EDITING`. Deterministic
  recalculation over the effective result moves the same revision to `READY`.
  Explicit approval moves it to `APPROVED`.
- Coach and viewer surfaces only consume approved revisions. Operators and
  annotators may preview editing and ready revisions.
- Contact CRUD is stored as a sparse review layer. AI callback results and
  immutable rally submissions are not rewritten.
- Court-side changes are effective from a rally ordinal through
  `CourtSideAssignment`; they are not media-timeline key points. Every editable
  or submitted segment displays its own left/right team snapshot. The newest
  ordinary draft may adopt a corrected assignment before submission, while an
  immutable historical submission continues to use a correction draft.
- A new rally starts with an `UNKNOWN` result. Z marks only its start and end,
  and X remains the contact command.

## Consequences

- High-frequency frame editing no longer generates one network mutation per
  pointer or keyboard change.
- Recalculation does not rerun GPU inference. It rebuilds effective event order,
  actor binding and downstream statistics from the accepted inference plus the
  review layer.
- Heatmaps normalize the right-side team into a common attacking direction.
  An error is not inferred from rally outcome unless a direct event result
  supports that label.
- Changing the next segment swaps the visible team labels and score orientation
  without changing capture time, PTS, frames or court coordinates. Correcting
  an immutable historical submission continues to use the correction-draft
  workflow.
