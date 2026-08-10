# ADR 0029: Boundary-first rally annotation and AI contact proposals

## Status

Accepted — 2026-08-10

Decision owner: Main PM / architecture integration agent

## Context

Requiring an operator to create every contact anchor before submission duplicates work that the
analysis engine can propose from ball and player observations. The useful human input for a first
pass is the immutable rally interval: service and end. Result 1.0 required output contact events to
match input key points one-to-one, so AI-generated intermediate anchors require an additive,
versioned result and review contract.

## Decision

- `Z` is context-sensitive but retains one command meaning per state: it creates service when there
  is no ordinary open draft, and creates the authoritative terminal contact when that draft is open.
- The second `Z` is one durable `CREATE_CONTACT_KEY_POINT` transaction with
  `terminal_outcome=unknown`. It resolves the browser observation through the server sample index,
  creates the terminal point and changes the Rally to `READY`; `Enter` may then submit immediately.
- `X` remains available as an optional manual point and correction tool. It is not a submit
  prerequisite.
- `<`, `>` and `?` remain rally-level outcome controls and may replace the unknown outcome after the
  second `Z` without moving the terminal timestamp.
- A valid open draft may be extended beyond the previous rendered mask/post-roll estimate. Every
  new anchor must still belong to the room's DVR program, epoch, ready segment and sample index.
- Result 1.1 adds AI-generated intermediate contact proposals. Human boundaries retain their
  `source_key_point_id`; generated contacts use `anchor_origin=ai_detected`, a null source ID and
  optional detector confidence/evidence. Result 1.0 remains accepted with its strict one-to-one rule.
- Analysis Review 1.2 stores sparse frame overrides for AI-generated contacts. Operators may nudge a
  proposal by canonical frames or restore the provider result; central validation keeps all events
  strictly ordered and never mutates the immutable submission or raw result artifact.

## Consequences

- The minimum immutable submission contains exactly two human boundaries: service and terminal.
- Clip boundaries, capture timestamps, PTS and frame ordering remain server-authoritative and are not
  inferred by the browser or by the AI detector.
- Existing clients that send ordinary `CREATE_CONTACT_KEY_POINT` payloads continue to create
  non-terminal manual contacts.
- Automatic hit detection can combine smoothed ball velocity, acceleration, direction change and
  nearby player/action evidence, but low-confidence candidates must remain reviewable and removable.
