# ADR 0012: Immutable score corrections share one ordered ledger

Status: accepted

## Context

`RallySubmission` is immutable, and a submitted Rally can only be changed by opening a correction draft and producing a new submission linked through `supersedesSubmissionId`. The original `PointAward` table safely serialized first-time resolved outcomes, but it could not represent a later left-to-right, resolved-to-unknown, or unknown-to-resolved correction without either double-counting a Rally or mutating history.

## Decision

- `ScoreLedgerEntry` is the single set-level ordered ledger for every score mutation. `(setId, scoreRevisionAfter)` is unique, and `MatchSet.scoreRevision` is changed by compare-and-swap in the same serializable transaction.
- An initial resolved submission creates a `POINT_AWARD` ledger entry and its required `PointAward` detail row. An unknown initial submission creates neither and does not change the score.
- A correction computes `new active contribution - superseded active contribution`. A non-zero delta creates a `CORRECTION` ledger entry linked to both immutable submissions. This supports `(-1,+1)`, `(-1,0)`, `(0,-1)`, `(1,0)` and `(0,1)` without treating a correction as a second Rally.
- Old submissions, jobs and analysis runs are retained and marked `SUPERSEDED`; the new immutable submission becomes the Rally's active submission. Unknown submissions continue to keep all score snapshot fields null, while the separate ledger records any reversal caused by the correction.
- `createCorrectionDraft(submissionId)` restores the active immutable key-point snapshot into mutable draft rows. The old active submission remains authoritative until Enter creates the replacement. A no-op correction cannot be submitted.
- If key-point geometry and clip policy are unchanged and the source pipeline completed, the correction clones immutable ClipJob/AiJob/AnalysisRun metadata and geometry relations onto the new submission while referencing the same immutable media/overlay assets. No provider call or transcoding is repeated; outcome-dependent Coach aggregates read the new active submission. If reusable completed geometry is unavailable, the normal queued pipeline runs.

## Consequences

The score history is append-only and reconstructable across winner changes and explicit unknown outcomes. Existing `PointAward` rows are deterministically backfilled into the shared ledger by reusing their UUIDs. Consumers must read the Rally's active submission for current outcome truth and the ordered score ledger for audit history; they must not sum all historical `PointAward` and correction rows independently. Immutable overlay assets may now be referenced by multiple AnalysisRuns so outcome-only corrections can reuse bytes without duplicating objects.
