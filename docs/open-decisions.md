# Open decisions

See section 27 of `MASTER_IMPLEMENTATION_SPEC.md`. Do not silently resolve these questions in code.

## Resolved: human ball events and coach replay vNext

Status: resolved by the product owner on 2026-08-16 and amended on 2026-08-17 by
[ADR 0046](./adr/0046-manual-ball-results-and-conservative-third-point-inference.md).

The analysis, proposed defaults, implementation phases, and verified source map are in
[`HUMAN_BALL_EVENTS_AND_COACH_REPLAY_SPEC.md`](./HUMAN_BALL_EVENTS_AND_COACH_REPLAY_SPEC.md).

1. Event ordinal and hotkeys
   - First/second means the first and second valid keypoints in canonical time order, regardless of manual or automatic origin; boundaries are excluded.
   - X creates HIT; C modifies the selected point or creates SPIKE and is valid from the third point.
   - V/B only toggles SUCCESS/FAILURE on a selected typed point. It never creates a point or changes its kind.
   - A third point conservatively fills only untouched defaults: first-serve null result becomes SUCCESS and second CONTACT becomes RECEIVE; the receive result stays null.
   - A shared deterministic validator repairs invalid ordering/coverage and reports every automatic correction.
2. Human result taxonomy
   - Serve, receive, and spike share `SUCCESS | FAILURE | null`.
   - Rally scoring remains a separate field; ball-event result does not encode the scoring side.
   - Draft and immutable submissions may retain null after a Chinese warning and explicit continue action.
3. Architecture and delivery
   - Human event kind/result is the coach analytics truth; model action is overlay-only.
   - Path geometry is a projection from stored evidence and remains unavailable when evidence is insufficient.
   - Live collection playback is a bounded client playlist; downloadable montage is a durable Worker render.
   - This phase only adds a CLI/env VLM capability switch. Disabled workers do not initialize or advertise VLM. Model/GPU changes are deferred.

Implementation must still not overload MarkerKind or AI action with human BallEvent semantics.
