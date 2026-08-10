# ADR 0028: Match-scoped roster position

## Status

Accepted — 2026-08-10

Decision owner: Main PM / architecture integration agent

## Context

Player position belongs to a tournament or match roster, not permanently to the global player. The
same player can be registered differently between matches, and imported official rosters commonly
publish compact position codes. The existing roster research Prompt returned only name and jersey
number, so the position could not be persisted or reviewed.

## Decision

- Store `position` on `MatchRosterEntry` as `RosterPosition` with `UNSPECIFIED`, `OH`, `MB`, `OPP`,
  `S`, `L` and `DS`.
- Expose a non-null `position` on the GraphQL `MatchRosterEntry`. Keep `RosterInput.position` and
  `RosterEditInput.position` optional for compatibility with existing consumers; omitted new rows
  become `UNSPECIFIED`, while omitted edits preserve the existing position.
- Require an explicit non-`UNSPECIFIED` choice in the current Nuxt create/edit forms and render the
  choice with the Reka-backed shadcn-vue Select pattern rather than a native `select`.
- Upgrade the clipboard research format to `vollyai.roster-import.v2`. Imported players must include
  one of the six real position codes, and the Prompt includes the Traditional Chinese labels.
- Add `position` to coach replay track identity as the additive `schema_version: 1.1.0` response.
  The Nuxt consumer also accepts `1.0.0` responses and treats their missing position as unspecified.
- Do not add roster data to the external AI Job contract. The roster research Prompt is a control UI
  import workflow and is not part of immutable rally analysis input.

## Migration and compatibility

Migration `20260810190000_match_roster_position` creates the enum and backfills existing roster rows
through the `UNSPECIFIED` default. GraphQL input compatibility is additive; the output field is
available to migrated clients without changing existing selections.

## Consequences

- Position remains match-scoped and follows roster-entry identity history.
- Existing databases and older clients continue to work, but the current UI asks operators to resolve
  unspecified positions before saving a roster.
- Coach player analytics can display the registered position without inventing an AI action label.
- Coach replay track identities expose the same match-scoped position and jersey number. The virtual
  court renders mapped hitters as `[OH] 8`, keeps `ID <trackId>` for unmapped tracks and uses `[?]`
  only for migrated roster entries whose position is still `UNSPECIFIED`.
