# ADR 0041: Exact-frame correction reuse over immutable analysis evidence

Status: Accepted

Date: 2026-08-17

## Context

ADR 0038 requires a post-submit key-point time edit inside stored evidence coverage to avoid heavy
AI. The first correction implementation reused media and analysis only when every boundary and
key-point timestamp was byte-for-byte unchanged. Treating a moved contact as a full analysis request
wasted court, tracking, pose, and ReID work. Copying its old `ClipKeyPointMapping` was not an
acceptable shortcut because it would silently attach the human event to the wrong canonical frame.

The canonical clip timing manifest already contains a checksum-bound, one-to-one `frame_map` from
capture epoch, source PTS, capture time, and capture frame to canonical clip PTS, time, and frame.
AnalysisData and every-frame pose evidence use that canonical frame index.

## Decision

A correction submission may reuse completed clip and analysis evidence when all of the following
hold:

- START and END boundaries, clip policy, and pre/post roll are unchanged;
- the contact count and canonical ordinal topology are unchanged;
- every edited key point resolves exactly to one `frame_map` row by capture epoch, capture frame,
  capture time, and source PTS; and
- the source has a completed canonical clip and completed analysis lineage.

The successor submission receives a new completed `ClipJob` row referencing the immutable clip and
timing assets. Its own `ClipKeyPointMapping` rows use the matched canonical clip PTS/time/frame. The
successor sets `analysisSourceRunId`; it does not create a new `AiJob` or `AnalysisRun`.

When timing changed, the server queues `AnalysisContactAssociationJob` rows keyed by the successor
submission key-point ids and canonical frames. The existing workflow worker evaluates them from
persisted AnalysisData and person-pose evidence, using wrist/forearm geometry first and bbox/action
fallbacks second. An explicit human roster actor suppresses that automatic association request.

Coach replay and analytics project the successor's human event ordinal onto its submission-scoped
clip mapping. They prefer the successor-keyed association projection, while the immutable source
analysis event id remains the review-command identity. The source submission, source analysis
contacts, and source review corrections are not rewritten.

If the timing manifest is absent, malformed, ambiguous, or lacks an exact source frame, reuse fails
closed and the normal clip/analysis workflow is queued. Boundary or contact-topology changes also use
that workflow because they change evidence coverage or event structure.

## Consequences

Type, result, player, and in-segment timestamp corrections can be submitted without rerunning court,
tracking, pose, action, or ReID inference. Timestamp changes still receive a deterministic,
auditable actor refresh. Reused artifacts remain immutable and searchable through their original
lineage.

The timing manifest parser now retains canonical clip PTS and accepts signed source PTS. Tests must
cover exact mapping, signed PTS, no new AI job, successor-scoped association, and fail-closed
fallback behavior.

Contact insertions/deletions and boundary edits remain outside this reuse class until a versioned
projection model can represent topology and path regeneration without weakening immutable
submission semantics.
