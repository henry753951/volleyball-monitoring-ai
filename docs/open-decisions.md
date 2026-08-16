# Open decisions

See section 27 of `MASTER_IMPLEMENTATION_SPEC.md`. Do not silently resolve these questions in code.

## Resolved: human ball events and coach replay vNext

Status: resolved by the product owner on 2026-08-16. The public-contract implementation may proceed.

The analysis, proposed defaults, implementation phases, and verified source map are in
[`HUMAN_BALL_EVENTS_AND_COACH_REPLAY_SPEC.md`](./HUMAN_BALL_EVENTS_AND_COACH_REPLAY_SPEC.md).

1. Event ordinal and hotkeys
   - First/second means the first and second valid keypoints in canonical time order, regardless of manual or automatic origin; boundaries are excluded.
   - C/V/B modifies the selected point or creates a typed point when nothing is selected.
   - C is valid from the third point; V is receive success and B is receive error, both valid only on the second point.
   - A shared deterministic validator repairs invalid ordering/coverage and reports every automatic correction.
2. Human result taxonomy
   - Serve: POINT_SCORED, SUCCESS, ERROR.
   - Receive: SUCCESS, ERROR, POINT_LOST.
   - Spike: SUCCESS, FAILURE.
   - Draft results may be unset; immutable submissions do not store UNKNOWN.
3. Architecture and delivery
   - Human event kind/result is the coach analytics truth; model action is overlay-only.
   - Path geometry is a projection from stored evidence and remains unavailable when evidence is insufficient.
   - Live collection playback is a bounded client playlist; downloadable montage is a durable Worker render.
   - This phase only adds a CLI/env VLM capability switch. Disabled workers do not initialize or advertise VLM. Model/GPU changes are deferred.

Implementation must still not overload MarkerKind or AI action with human BallEvent semantics.
