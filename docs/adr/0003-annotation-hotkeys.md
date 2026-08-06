# ADR 0003: Annotation hotkeys and user-defined aliases

- Status: Accepted
- Date: 2026-08-07
- Decision owner: Main PM / Tech Lead

## Context

`SYSTEM_SPEC_V3_2` defines six annotation meanings with default bindings `Z`, `Space`, `<`, `>`, `?` and `Enter`, with arrow keys as the default frame/player controls. The three outcome keys each invoke one atomic `CLOSE_RALLY` variant; there is no standalone end-rally binding. The product owner approved user-editable physical bindings. Command meaning remains the operator-safety contract; a remap changes only which physical key invokes it.

Operators also need device-friendly shortcut customization. TanStack Hotkeys provides a Vue adapter, typed bindings, scoped commands, recording, conflict detection, input filtering and platform-aware display. The library is currently alpha, so application code must not depend on it from scattered components.

## Decision

1. The Annotation implementation will use `@tanstack/vue-hotkeys` behind one application-owned adapter/composable. The dependency will be pinned to an exact reviewed version when implementation starts.
2. The six annotation commands and media-control commands have the V3.2 keys as defaults, but users may replace those physical bindings. Remapping never changes command meaning; each close variant still targets the server-confirmed last key point, terminalizes it, records the rally-level outcome and creates no timestamp or score event.
3. The settings UI records and persists one active binding for each configurable command. It must provide a single Restore All Defaults action that atomically restores the V3.2 annotation and arrow-key defaults.
4. The recorder must reject duplicate bindings, browser-reserved gestures and commands active in the same scope. It must display a clear reason and leave the prior binding intact.
5. Annotation shortcuts are active only in the annotation command scope, are suppressed while typing in form controls, and yield to modal/dialog scopes.
6. Preferences use a versioned, centralized repository/composable with reset-to-default and migration behavior. Components do not write directly to browser storage. A future server-synced preference store may replace the local adapter without changing command registration.
7. The settings menu, control deck and shortcut cheat sheet use the same command registry as runtime registration and render every visual key badge with TanStack Hotkeys `formatForDisplay`. Components must not hand-format modifier names or platform symbols.

## Required tests

- Remapped keys invoke exactly the selected command, and the previous key no longer invokes it unless it is assigned elsewhere.
- Restore All Defaults atomically restores `Z`, `Space`, `<`, `>`, `?`, `Enter` and the default arrow-key media controls.
- Left, right and unknown still send one `CLOSE_RALLY` carrying the current last key-point target plus the strict outcome; they create no new timestamp, score frame or score event.
- Binding recording, normalization, conflict rejection, persistence migration and reset are covered by unit tests.
- Visual key badges are asserted against `formatForDisplay` output for macOS and Windows/Linux conventions.
- Input, textarea, select and editable-content focus suppress annotation commands.
- Scope precedence, reconnect/remount cleanup and reduced accidental double-registration are covered in component/browser tests.
- Touch controls remain available and semantically identical without a keyboard.

## Consequences

The product gains fully customizable keyboard muscle-memory support while command semantics and touch controls remain stable. Restore All Defaults provides a safe recovery path. The adapter boundary contains alpha-library API churn and gives the project an escape path if the dependency becomes unsuitable.
