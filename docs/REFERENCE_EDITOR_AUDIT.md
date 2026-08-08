# Reference editor audit: volleyball-ai-contract-lab

- Reference checkout: `H:\Repos\volleyball-ai-contract-lab`
- Reviewed commit: `8b83561`
- Review date: 2026-08-07
- Purpose: interaction and fixture-shape reference only

`volleyball-ai-contract-lab` is a single-user, offline, uploaded-file mock lab.
It is not a source of truth for the monitoring product's contracts, persistence,
media authority or deployment architecture. `SYSTEM_SPEC_V3_2` and the approved
ADRs continue to win whenever the projects differ.

## Product boundary

- The annotation workstation is PC-first and optimized for a trained operator.
- Only the coach display must be an installable, landscape-first iPad PWA.
- The annotation workstation may still be responsive and touch-capable, but an
  iPad layout must not dilute desktop information density or keyboard speed.
- TanStack Hotkeys owns annotation bindings. The settings surface supports
  conflict-safe customization, Restore All Defaults and visible
  `formatForDisplay` labels.
- Canonical annotation state arrives from committed server ACKs/snapshots. The
  browser cursor, uploaded-file time and local storage are never domain truth.

## Keep

- Dense three-region desktop composition: media, timeline and inspector remain
  visible together during the primary marking loop.
- Separate rally and key-point timeline lanes, bounded zoom/pan, direct scrub,
  exact frame step and selected-key-point nudge affordances.
- Visible distinction between editable draft and immutable submission. In the
  monitoring product gray means editable/unsubmitted and green means an
  immutable submission exists; processing state requires a separate text/badge.
- Corrections create a new draft and later a new immutable submission instead
  of editing a submitted snapshot.
- Restrained, precision-preserving feedback: immediate button press feedback
  and a short draft-to-submitted continuity transition, with reduced-motion
  support and a text/status announcement.

## Adapt

- Render the compact bottom deck from the shared command registry. Use Z for
  service, X for contact, `<`, `>` and `?` for atomic close/outcome, and keep
  Enter submission plus Space playback/pause available through the keyboard registry.
- Replace browser-time marking with the existing bounded playback-window,
  cursor-observation and authoritative server resolution flow.
- Replace local draft/session persistence with room snapshots, committed ACKs,
  revision conflicts and explicit reconnect/recovery states.
- Preserve the compact workstation while adding labeled status language,
  accessible timeline/key-point controls, live announcements and keyboard-
  operable upload/drop affordances where uploads are still relevant.
- Keep motion out of the playhead and key-point dots. High-frequency precision
  controls must not drift, pulse or animate independently of the resolved frame.

## Reject

- Any X/standalone rally-end workflow; X is contact only and Space is playback/pause only.
- A new score timestamp, score event or score frame. Rally score is an outcome
  stored while terminalizing the current server-confirmed last key point.
- Client `currentTime * fps`, requestVideoFrameCallback output or a locally
  generated timestamp as a canonical anchor.
- Mutable localStorage drafts as business truth, direct whole-file DVR loading,
  `preload="auto"` for the full archive, or a client-selected clip roll.
- The mock lab's ball JSON or export documents as public monitoring contracts.
- Decorative playhead/key-point animation, status color as the only state cue,
  and wording that suggests close/outcome creates a separate end event.

## Export-data fixture policy

The original untracked `.data/exports` snapshot contained 40 files totaling
87,165,356 bytes: 7 MP4 files, 14 JPEG files, 18 valid JSON documents and one
text file. It includes real media and credential-/identity-shaped values, so no
raw artifact is copied into this repository.

Phase 4 may derive small deterministic JSON fixtures that preserve only useful
shape and edge-case semantics:

- unresolved, candidate and multi-actor contact associations;
- optional action/confidence and unknown/null outcome cases;
- terminal and non-terminal events;
- analysis-run-local tracks, with tracking present or absent;
- external `court_pos` values outside `0..1` without central projection or
  clamping;
- optional/missing ball and frame fields; and
- callback processing, completed and failed states.

Every derived fixture must replace URLs, callback credentials, hashes, source
filenames, IDs, timestamps and unique metadata with deterministic synthetic
values; reduce arrays and coordinates to the minimum case; and validate against
the monitoring repository's approved schema. Raw MP4, JPEG, JSON and text
exports are never committed.

## Review limitations

Static source and data-shape review completed. A fresh visual run of the
reference editor was unavailable because its clean worktree did not contain
installed Nuxt dependencies; the attempted process exited and no listener or
browser session was left running. The deterministic UI detector reported no
mechanical findings, but manual review still found the product-boundary and
accessibility mismatches above.
