# ADR 0044: Active unbound GIDs, revisioned corrections, and central jersey assistance

Status: Accepted

Date: 2026-08-17

Supersedes: ADR 0042 sections "Soft six-player lineup prior" and "Human correction" where this
record defines different activation or correction behavior.

## Context

The first soft-lineup implementation still treated uncertainty as an unresolved/review state and
could leave a valid Local ID without a GID. Its greedy six-player guard also allowed an earlier
low-quality candidate to consume capacity before a later valid player. This made temporary duplicate
detections, court-side jitter, substitutions, and first-clip empty banks operational blockers.

The existing human correction UI also conflated two independent failures:

- a Local ID was placed in the wrong visual GID; and
- the visual GID was correct but its roster-player label was wrong.

Finally, jersey-number VLM was embedded inside the external ReID feature worker. That made an
optional, operator-facing decision aid part of every feature generation and allowed an uncertain
number to influence automatic association before a human saw the evidence.

## Decision

### Every eligible Local receives an active GID

- Every Local tracklet accepted as person evidence receives exactly one active match-scoped GID.
- A strong legal match uses an existing GID. Otherwise Central creates a new ACTIVE, UNBOUND GID.
- UNBOUND means only that the GID has no roster-player binding. It is not a review, error, or blocked
  state and never prevents replay, annotation, analytics, or later identity work.
- New automatic membership evidence is usable at a conservative weight. Human-confirmed membership
  has higher weight. Activation and feature-bank trust are separate concepts.
- Non-co-visibility only removes a hard cannot-link. It is never positive proof that two Local IDs are
  the same person.

### Six-player state is a soft occupancy prior

- Six limits a transient on-court lineup hypothesis, not match-long GIDs and not valid observations.
- Exact same-frame co-visibility remains a hard cannot-link after duplicate-observation adjudication.
- A seventh co-visible eligible Local creates its own GID if it cannot legally match. It never steals,
  deletes, unbinds, or shifts an existing GID.
- Assignment must optimize the current group jointly. `NEW_GID` is always a legal candidate.
- Court side and team are temporally aggregated supporting evidence. A momentary side change cannot
  rewrite a GID's team.

### Human correction commands are explicit

The canonical commands are:

- `REBIND_GID_PLAYER_FROM_HERE`: keep visual memberships and revise the GID-to-roster binding from
  the selected rally forward. If the player is already bound, atomically swap the two bindings.
- `MOVE_LOCAL_TO_GID`: move one Local membership to another GID after cannot-link validation.
- `SWAP_LOCAL_GIDS`: atomically exchange two Local memberships without changing GID-player labels.
- `LOCAL_PLAYER_OVERRIDE`: change only the Local's effective roster projection; do not train on it.
- `RETURN_LOCAL_TO_AUTOMATIC`: supersede a manual Local projection and reapply the newest legal
  automatic decision.

Every command appends immutable revisions. Earlier raw evidence and earlier effective history remain
unchanged. Corrections supersede wrong memberships and cause later bank/adaptation snapshots and
automatic associations to be rebuilt in chronological order. Court, detector, tracker, ball, action,
and every-frame Pose are not rerun.

GID roster binding is a revisioned relationship. `ReidPersonCluster.canonicalRosterEntryId` may be
maintained as a current read projection, but it is not historical authority.

### There is no mapping-complete gate

Identity assignment is continuous. Any confirmed Local or GID assignment becomes immediately useful.
Unassigned Local IDs remain active and usable. No operator action marks a run as "player assignment
complete", and downstream consumers must not require every Local to have a roster player.

### Jersey recognition is an operator-triggered Central workflow

- External ReID feature and association contracts contain no VLM modality or jersey response.
- The operator may request a jersey suggestion run for one AnalysisRun.
- Central reads saved every-frame Pose/crop evidence, scores torso-visible observations, randomly
  samples up to ten frames from the best-quality pool, crops the selected Local, and composes one
  montage.
- The workflow calls an OpenAI-compatible `chat/completions` endpoint configured by environment:
  `JERSEY_VISION_API_KEY`, `JERSEY_VISION_BASE_URL`, and `JERSEY_VISION_MODEL`.
- Raw response, normalized jersey candidates, selected frame indices, model namespace, montage hash,
  and errors are durable evidence.
- Suggestions never write identity automatically. The UI displays a diff against current bindings;
  each item can be accepted or skipped. Hovering an item shows the Local's animated crop preview.

## Consequences

- First clips bootstrap without roster-precreated GIDs.
- False splits are preferred over false merges; operators can merge or move evidence later.
- A short-lived seventh detection may create a low-trust GID, but it cannot corrupt one of the six
  established identities.
- Player analytics are partial by design: assigned evidence contributes, unbound evidence remains
  visible but is excluded from player-specific aggregates.
- NPA or another adaptive identity head must consume an exact immutable adaptation snapshot and may
  use only eligible seeds. Active UNBOUND GIDs are not roster-classification labels.
