# ADR 0046: Manual ball results and conservative third-point inference

Status: Accepted

Date: 2026-08-17

## Context

The first human ball-event implementation overloaded V/B as receive commands and treated the
second keypoint as RECEIVE immediately. That made a two-point serve-out rally look like a receive,
allowed V/B to create new keypoints, and caused the server normalizer to overwrite deliberate human
choices. Result selection also blocked submission even though the operator may not be able to decide
success or failure at annotation time.

## Decision

- X creates an unclassified CONTACT. C creates or changes a legal third-or-later point to SPIKE.
- V and B never create a keypoint and never change its kind. They toggle SUCCESS and FAILURE on the
  currently selected SERVE, RECEIVE, or SPIKE. CONTACT has no result.
- The fixed bottom command strip contains Z, X, C, rally outcome controls, and Settings. V/B are
  shown as two result buttons in the selected-keypoint editor and remain configurable keyboard
  commands.
- Human results are nullable for SERVE, RECEIVE, and SPIKE. Submission shows a Chinese warning that
  lists unresolved typed points; the operator may return to edit or explicitly continue. The server
  accepts the nullable result in the immutable submission.
- SERVE records `serve_style` as JUMP or STANDING. New and legacy-null serves normalize to JUMP.
- Ordinal 1 is SERVE. Ordinal 2 initially remains CONTACT because it may be an out-of-bounds landing.
  Once a third keypoint exists, the server performs two conservative, one-time inferences:
  - an unlocked, empty serve result becomes SUCCESS;
  - an unlocked second-point CONTACT becomes RECEIVE with a null result.
- Inference uses persisted `kindLocked` and `resultLocked`, not merely a null value. Once a human has
  changed or cleared that field, later points do not overwrite the decision.
- Receive context remains derived from the immediately previous event: after SERVE it is shown as
  接發, after SPIKE as 接殺, otherwise 接球.

## Consequences

- BallEvent contract version advances to 2.0.0 and adds optional `serve_style` plus repair codes for
  serve-style defaults and conservative third-point inference.
- BallEvent results are unified as nullable `SUCCESS | FAILURE` for SERVE, RECEIVE, and SPIKE;
  CONTACT remains resultless. PostgreSQL adds nullable `serveStyle` and replaces the old per-kind
  result enum values.
- The v6 receive-specific V/B preference schema is retired without compatibility mapping. Version 7
  starts from the generic success/failure defaults so stale receive semantics cannot leak forward.
- Rally scoring, rather than a ball-event result, remains the source of direct-point truth.
