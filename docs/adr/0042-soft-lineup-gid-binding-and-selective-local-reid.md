# ADR 0042: Soft lineup prior, independent GID binding, and selective local ReID

Status: Accepted

Date: 2026-08-17

Extends: ADR 0037 and ADR 0039

## Context

The fixed-roster experiments in `H:/Repos/volley-reid` show that a six-player lineup prior can make
association substantially more stable. Copying the experiment literally is unsafe: it forces every
detection into one of six permanent slots, cannot abstain, and conflates a current lineup position
with a match-long person identity. Real input can temporarily miss or duplicate a person, court
geometry can drift, players leave and re-enter, and substitutions mean a team has more than six
people over a match.

The current provider also used a custom harmonic-mean tracker even though the referenced selective
mask propagation checkout contains DeepEIOU and SAM3 identity-switch correction. At the domain layer,
pre-creating one person cluster for every roster entry made GID and player assignment effectively the
same thing, preventing safe correction when visual grouping was right but the player label was wrong.

## Decision

### Three independent identity layers

1. **Local ID** is analysis-run-local tracking identity. DeepEIOU consumes every-frame person boxes
   and OSNet descriptors from the multitask provider.
2. **GID** is a match/team-scoped visual person cluster. It may contain many non-co-visible Local IDs
   and has no required roster player.
3. **Player binding** is a human-confirmable, revisioned relationship from a GID to a roster entry.
   A later Local ID associated to a bound GID inherits that player projection. GID grouping and player
   binding remain separately correctable.

The worker must not pre-create GIDs from roster entries. New GIDs arise from actual evidence or an
explicit manual assignment. The current cluster roster field is an active binding projection, not the
cluster's identity or feature key. Immutable bank snapshots and assignment revisions preserve the
answer used by earlier runs.

### Local tracking and selective SAM3

- DeepEIOU is the default run-local tracker and receives an OSNet embedding for every person
  detection on every canonical frame.
- Assignment margins and raw DeepEIOU boxes are retained for the duration of the analysis job.
- SAM3 runs out of process in the selective-mask-propagation environment only when upstream
  low-margin, gap, or witness rules open an ambiguity window. It does not rerun detector, court, pose,
  action, or feature extraction.
- Only upstream frame-effective rename events change Local IDs. Co-visible ID collisions invalidate
  the SAM3 output.
- Missing SAM3 runtime, timeout, model failure, decode mismatch, or invalid output falls back to the
  complete DeepEIOU result and records a visible machine-readable status. It never fails otherwise
  valid base analysis.
- SAM3 is an explicit environment/CLI capability switch. Docker remains disabled until its runtime
  and weights are deliberately packaged or mounted.

### Soft six-player lineup prior

- Six means the maximum number of simultaneously active player identities for one team, not six
  permanent match identities.
- Exact co-visibility is a hard cannot-link: two Local IDs visible in the same frame cannot resolve to
  the same GID.
- A seventh co-visible candidate abstains instead of creating, deleting, or shifting a slot.
- A missing detection leaves an active identity absent. An extra detection remains unresolved unless
  sufficient evidence supports a legal identity.
- Non-co-visible Local IDs may resolve to the same GID, enabling leave/re-enter recovery. Substitutes
  and liberos may create additional match-long GIDs without changing the six-current-player capacity.
- Court side is supporting evidence, not permanent identity. Side aggregation uses a centre-line
  deadband, minimum observation count, and minimum majority share. Ambiguous tracks become UNKNOWN
  and require review rather than being guessed into the other team.

This first implementation applies co-visible uniqueness and soft capacity. A later calibrated
lineup-state model may add recency/rotation/substitution transitions, but it must preserve abstention
and may not turn momentary side jitter into a team switch.

### Human correction

- **GID 與球員配對錯了 (`from_here`)** keeps the visual GID and changes its player binding from the
  correction point forward. If the selected player is bound to another GID, the transaction swaps the
  two GID bindings; every affected later Local ID follows its GID. Earlier projections remain unchanged.
- **只有這個 Local ID 的 GID 判錯 (`split_identity`)** moves only that Local evidence to the selected
  player's GID, or creates a new GID. A same-frame cannot-link rejects an illegal merge.
- **只改這個 Local 的顯示 (`clip_only`)** changes only the effective Local projection. It does not
  change the GID binding or future feature bank.

Player selection must show the previous player and any occupied GID before confirmation. The
transaction appends correction, assignment, active projection, and eligible membership revisions
under one identity revision. It never mutates earlier raw descriptors or analysis evidence.

## Consequences

- The same roster player can legitimately appear on multiple non-co-visible Local IDs through one
  GID; replacement is limited to an exact same-frame conflict.
- Later clips automatically inherit a human-confirmed player only after association resolves to the
  corresponding GID. Low confidence or low margin still abstains.
- A wrong automatic GID does not silently poison the future bank: human split/reject revisions remove
  the wrong eligible membership from later immutable snapshots.
- Local tracking quality can improve independently of cross-clip GID accuracy. DeepEIOU/SAM3 metrics,
  GID association metrics, and final roster accuracy must be evaluated separately.
- The fixed-six-slot and nested-part workbenches remain evaluation/reference code. Their forced
  assignment and private fold results are not production calibration evidence.
