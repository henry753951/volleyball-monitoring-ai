# ADR 0040: Page-scoped annotation workstation services

Status: Accepted

Date: 2026-08-16

## Context

The annotation route accumulated draft lifecycle, media cursor recovery, key-point editing,
timeline selection, submission/correction, analysis review, identity assignment, confirmation
dialogs, feedback, and button availability in one Vue page. Child components received large prop and
emit surfaces and sometimes created their own composable instances. That made it possible for one
visible control to be enabled while its keyboard equivalent was blocked, for two identity surfaces
to own competing dialogs, and for late asynchronous cursor or selection responses to overwrite a
newer local action.

ADR 0036 already requires the editable draft and active selection to remain client-owned. The UI
architecture must make that invariant structural rather than depend on every component remembering
the same checks.

## Decision

The annotation route is the composition root for one page-scoped `AnnotationWorkstationService`.
It creates the service graph once, provides it with a strict Vue injection key, and disposes it when
the route unmounts. `useAnnotationWorkstationService()` throws when no provider exists; it never
creates a fallback room, API client, action manager, or draft state.

The facade exposes cohesive domains rather than individual refs as props:

- `annotation.room` owns realtime commands, the client outbox, reconnect/rebase, draft ownership,
  snapshots, presence, and processing updates;
- `annotation.model` derives submitted rallies, local drafts, clip masks, sides, scores, and active
  context without becoming a second source of truth;
- `annotation.keyPoints` owns optimistic point time, drag resolution, overlap validation,
  coalesced frame nudging, editing intent, and deletion;
- `timeline` owns explicit/cursor/local-draft selection priority and deterministic A/D navigation;
- `segments` owns permanent deletion, set transitions, side swaps, and rally placement;
- `playback` is the port used by UI components for play, frame movement, seek, preview seek, rate,
  and key-point navigation while authoritative DVR services continue to resolve browser
  observations;
- `analysis.review` and `analysis.revision` own sparse human overrides and revision actions;
- `identity` owns one shared assignment controller, job actions, preview state, and an explicit
  interaction-surface owner so the panel and popover cannot display duplicate dialogs;
- `sync` owns resync/conflict recovery and failed-processing retry;
- `preferences` owns overlay persistence, settings navigation, and clip-policy mutation;
- `confirmation` serializes destructive or ambiguous decisions and locks all dialog buttons while
  the selected callback is running;
- `feedback` is the single structured notification channel; and
- `actions` is the single command registry and resource-lock manager used by buttons, dialogs, and
  keyboard shortcuts.

Every action definition provides a stable id, group, label, availability, pending state, disabled
reason, resource locks, and executor. A component reads `actions.state(id)` and calls
`actions.execute(id, payload)`; it does not duplicate business validation in a click handler.
Keyboard and touch commands use the same ids as visible controls. Domain services may still perform
defensive validation because action availability is an interaction hint, not an authorization
boundary.

UI components may retain strictly presentational state such as an open popover anchor, a resizable
panel, a local form field before saving, or an HTML video/canvas element reference. They must not
retain a parallel Rally selection, pending command, optimistic key-point timestamp, identity client,
analysis patch, or submission state. The route may adapt browser media events into service calls;
browser cursor values remain observations under the existing media contract.

## Required behavior

- `OPEN` and `READY` remain editable by the owning tab until immutable submission.
- Peer drafts and cursor broadcasts never replace the local active draft or close its segment.
- Key-point order is capture time then stable id. Stale async draft loads and cursor resolutions are
  ignored by generation checks.
- Held frame commands coalesce, flush while held, and have a watchdog so a missing key-up cannot
  freeze the workstation. Player-frame and selected-key-point gestures have one explicit owner.
- A key-point drag is optimistic only in the projection exposed by `annotation.keyPoints`; the room
  snapshot is unchanged until the matching playback window and authoritative cursor resolve.
- Z/X/C/V/B, outcomes, submit, correction, and automated repairs continue through the annotation
  command validator. UI layout does not redefine their rules.
- Submitted Rally data remains immutable. Human analysis and identity changes create versioned
  review/correction records and do not silently rerun unrelated model stages.
- All services are disposable and tests construct them explicitly. Tests do not rely on hidden
  process-wide singletons.

## Consequences

The route remains responsible for composing backend clients and adapting real video/canvas events,
but feature state and operations have named owners. Component APIs become primarily display data;
functional operations travel through the injected facade. Adding a button or shortcut now requires
registering or reusing an action id instead of creating another boolean and handler.

The strict provider intentionally makes standalone component tests more explicit: they provide the
small service surface under test. This cost prevents production components from silently operating
against a different room or identity client.

This is a frontend architecture change. It does not change public wire schemas, Rally submission
immutability, media authority, ReID evidence contracts, or worker job boundaries.
