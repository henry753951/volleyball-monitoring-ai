# ADR 0038: Human ball events and deterministic keypoint normalization

Status: Accepted

> Superseded in part by ADR 0046 for ordinal-2 inference, V/B semantics, serve style, and optional
> submission results.

Date: 2026-08-16

## Context

Annotation Realtime 3.0 separates START/END boundaries from contact keypoints, but a keypoint only
stores SERVICE or CONTACT timing semantics. Coach analytics therefore falls back to model action
labels and cannot represent the product-owner classifications for serve, receive, spike, their
results, or a human actor override. UI-only hotkeys would create a second, inconsistent rule set and
would still allow delayed commands, automatic keypoints, boundary edits, or correction drafts to
leave impossible event ordering behind.

The accepted product specification is
[`HUMAN_BALL_EVENTS_AND_COACH_REPLAY_SPEC.md`](../HUMAN_BALL_EVENTS_AND_COACH_REPLAY_SPEC.md).

## Decision

### Keypoints and boundaries

- START and END remain Rally boundaries and never count as a ball-event ordinal.
- Every non-deleted keypoint inside the boundary coverage participates in one canonical order:
  capture time, capture frame, sequence index, then stable keypoint id.
- The first and second valid keypoints mean the first and second entries in that order, regardless of
  whether the keypoint came from a user, an automatic proposal, or a correction copy.
- KeyPoint remains the mutable timing anchor. Human ball semantics are a one-to-one BallEventDraft
  record instead of a new MarkerKind value. An immutable RallySubmissionBallEvent references the
  immutable RallySubmissionKeyPoint snapshot.

### Event semantics

Event kinds are SERVE, RECEIVE, CONTACT, and SPIKE.

- Ordinal 1 is SERVE.
- Ordinal 2 is RECEIVE.
- Ordinal 3 and later may be CONTACT or SPIKE.
- Serve results are POINT_SCORED, SUCCESS, and ERROR.
- Receive results are SUCCESS, ERROR, and POINT_LOST.
- Spike results are SUCCESS and FAILURE.
- CONTACT has no result.
- Draft results may be null while editing. Immutable submissions do not store UNKNOWN.

V sets RECEIVE/SUCCESS. B sets RECEIVE/ERROR. Receive POINT_LOST is an explicit UI choice in the
same control group. C sets SPIKE. With a selected keypoint, C/V/B modifies that keypoint. Without a
selection, the shortcut creates a keypoint carrying the requested semantics only when the resulting
ordinal is legal.

### Shared validator and automatic repair

One deterministic, side-effect-free rule engine accepts boundaries and the complete canonical
keypoint set and returns a normalized projection plus an ordered repair plan. Web uses it for
enabled states, optimistic preview, and notices. Server uses it as the authoritative transaction
plan. The server never trusts a client-supplied repair list.

Repair codes are stable wire values. At minimum they cover:

- tombstoning points before START or after END;
- rewriting ordinal 1 to SERVE and ordinal 2 to RECEIVE;
- rewriting an invalid early SPIKE to the ordinal-required kind;
- rewriting RECEIVE after ordinal 2 to CONTACT;
- clearing a result that is incompatible with the normalized event kind; and
- reindexing all retained points contiguously.

Every applied repair records keypoint id, before, after, and reason in the command acknowledgement
and audit event. The UI announces one summarized correction notice per command, not one toast per
repair. A disabled button and its keyboard shortcut use the same validator decision and reason.

END_RALLY applies normalization in the same transaction. If END precedes existing keypoints, those
points are tombstoned and reported. MOVE, CREATE, DELETE, RESTORE, SET_BALL_EVENT, correction-draft
creation, and automatic-keypoint ingestion also normalize before acknowledging.

### Submission

Submitting snapshots KeyPoint timing and BallEvent semantics into separate immutable tables. A
single-keypoint Rally must resolve the serve result as POINT_SCORED or ERROR. The UI asks
「這球是發球得分，還是發球失誤？」and may preselect an answer only when scoring-team evidence is
sufficient. The server rejects an unresolved single-point submission with a structured decision
required code instead of guessing.

Submitted data remains immutable. Post-submit edits use a correction draft and produce a successor
submission. Editing kind/result or a human actor does not enqueue heavy AI. Editing time inside
stored evidence coverage schedules only deterministic actor/path/analytics projection.

### Protocol version

Annotation Realtime 4.0.0 adds:

- optional BallEvent semantics to CREATE_CONTACT_KEY_POINT;
- SET_BALL_EVENT for selected-point changes;
- SET_BALL_EVENT_ACTOR for an explicit active-roster assignment or clear;
- BallEvent semantics and provenance in snapshots;
- structured auto-correction effects in acknowledgements; and
- structured validation reason codes used by both keyboard and touch controls.

Version 3 readers remain migration-only. The active web/server cutover is atomic because the new
semantics cannot be represented faithfully by v3 snapshots. Public fixtures, TypeScript contracts,
server validation, SDK models, generated GraphQL artifacts, and Web consumers migrate together.

### VLM capability switch

This ADR does not change the VLM model or its GPU placement. The provider worker receives a CLI/env
capability switch. When disabled it does not initialize VLM, advertise a VLM model namespace, or
claim work that requires VLM. Docker and k3s set the environment variable explicitly. Model
warm-up, quantization, and dedicated-GPU rollout remain a later measured decision.

## Consequences

- Human ball type and result become coach analytics truth while model action remains overlay
  evidence.
- Invalid ordering becomes a deterministic, auditable repair instead of a collection of UI guards.
- Automatic and manual keypoints share the same ordinal and submission rules.
- Moving END earlier can intentionally cancel later points without a refresh or stuck command state.
- New database tables, a v4 realtime schema, migration fixtures, SDK changes, and a hard web/server
  cutover are required.
- Historical Rally data may be discarded during the cutover as explicitly allowed by the product
  owner; immutable behavior is required for all new submissions after activation.
