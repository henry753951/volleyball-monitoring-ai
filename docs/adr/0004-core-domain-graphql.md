# ADR 0004: Phase 1B core-domain GraphQL vertical slice

- Status: Accepted
- Date: 2026-08-07
- Decision owner: Main PM / Tech Lead

## Context

Phase 1 must prove the first live PostgreSQL migration and an authenticated path that creates and reads a match, two court-side teams, rosters, set metadata and side changes. Phase 2 owns capture sessions, media ingest and authoritative playback timelines, so those APIs are deliberately excluded from this slice.

GraphQL Yoga with Pothos code-first remains the only domain API source. `packages/contracts/graphql/schema.graphql` is generated output and must never become a second hand-edited schema source.

## Decision

### Queries

- `viewer: Viewer!` returns the authenticated development/session identity.
- `matches: [Match!]!` returns matches visible to the viewer, newest first.
- `match(id: ID!): Match` returns one visible match or null.
- `health` remains public.

Non-admin match reads are membership-filtered. A missing identity produces an `UNAUTHENTICATED` GraphQL error; an inaccessible match is not disclosed.

### Transactional setup mutation

`createMatchSetup(input: CreateMatchSetupInput!): Match!` is the first vertical write. The input contains:

- match `title`, optional `venue` and optional `scheduledAt`;
- `leftTeam` and `rightTeam`, each with `name`, `shortName` and a roster array;
- each roster row contains `name` and `jerseyNumber`.

One PostgreSQL transaction creates both teams and their players, the match and `MatchTeam` rows, match roster snapshots, set number 1, the initial `CourtSideAssignment` effective from rally ordinal 1, and an `OPERATOR` membership for the creator. Empty/duplicate normalized names or jersey numbers, identical teams and invalid inputs are rejected before commit. Partial setup rows must not survive an error.

### Side-change mutation

`swapCourtSides(input: SwapCourtSidesInput!): MatchSet!` accepts `setId` and a positive `effectiveFromRallyOrdinal`. It closes the current open-ended assignment at the preceding ordinal and creates the reversed left/right assignment in one transaction. The new ordinal must be greater than the current assignment start. The set query exposes the complete ordered assignment history.

### Object boundary

The GraphQL graph exposes `Viewer`, `Match`, `Team`, `Player`, `MatchRosterEntry`, `MatchSet` and `CourtSideAssignment`, plus the existing Prisma enums needed by those objects. `Match` exposes its two teams, roster entries and ordered sets; a set exposes ordered side assignments. Dates use the existing `DateTime` scalar. No 64-bit values are added in this slice.

The Phase 1B public shape is exact so that the code-first server, generated SDL and Nuxt consumer cannot invent different aliases or nullability:

```graphql
type Viewer {
  id: ID!
  role: UserRole!
  email: String!
  displayName: String!
}

type Team {
  id: ID!
  name: String!
  shortName: String!
  players: [Player!]!
}

type Player {
  id: ID!
  teamId: ID!
  name: String!
}

type MatchRosterEntry {
  id: ID!
  teamId: ID!
  name: String!
  jerseyNumber: String!
}

type CourtSideAssignment {
  id: ID!
  effectiveFromRallyOrdinal: Int!
  effectiveToRallyOrdinal: Int
  leftTeamId: ID!
  rightTeamId: ID!
}

type MatchSet {
  id: ID!
  setNumber: Int!
  status: SetStatus!
  leftScore: Int!
  rightScore: Int!
  sideAssignments: [CourtSideAssignment!]!
}

type Match {
  id: ID!
  title: String!
  venue: String
  status: MatchStatus!
  scheduledAt: DateTime
  teams: [Team!]!
  rosterEntries: [MatchRosterEntry!]!
  sets: [MatchSet!]!
}
```

`MatchRosterEntry.name` is the match-time display-name snapshot, falling back to its linked player name only for legacy/null snapshot rows. The public input types are named `CreateMatchSetupInput`, `TeamSetupInput`, `RosterInput` and `SwapCourtSidesInput`. `health`, authenticated list/detail queries and both mutations retain the non-null return types stated above; only `match(id:)`, optional scalar fields and the assignment end ordinal are nullable.

### Authorization baseline

- Read queries require an authenticated identity.
- Setup and side-change mutations require `ADMIN` or `OPERATOR`.
- Local development may resolve a validated, deterministic identity from explicit dev headers or configured fallback environment values only when development auth is enabled. The user record is upserted server-side.
- Browser code never receives database, MinIO or integration credentials. Production auth must replace the development resolver without trusting client-supplied roles.

### Migration, seed and CI

- Create the repository's first Prisma migration from the approved existing schema; do not redesign the 38-model domain in the migration.
- Add an idempotent development seed with deterministic identities and a queryable demo match.
- Database integration tests run against PostgreSQL, apply `prisma migrate deploy`, prove transaction rollback, membership visibility, setup relations and ordered side swaps.
- GitHub CI provides a PostgreSQL service for the TypeScript/database job, applies migrations before database/server integration tests, exports the Pothos schema, and fails if the generated SDL differs from the committed snapshot.

### Frontend

- Replace hard-coded demo match selection with the real `matches` query.
- Add a landscape-friendly match setup form for both teams and roster rows, using the single transactional mutation.
- Protected match/annotation/settings routes use the authenticated viewer boundary.
- Successful setup navigates using the returned real match ID. GraphQL failures preserve form data and show an actionable error.

## Required tests

- Unauthenticated and insufficient-role requests fail with stable GraphQL error codes.
- Setup creates exactly one complete relation graph and creator membership; an invalid duplicate jersey rolls back everything.
- Non-admin viewers see only member matches; admin visibility is explicit.
- Side swaps close the prior range and return ordered, non-overlapping history.
- Pothos schema export is reproducible; representative setup/list/detail operations validate against it.
- PWA tests cover loading/empty/error states, setup submission, retained input after failure, real-ID navigation and route-guard behavior.

## Consequences

Phase 1B produces one useful end-to-end domain workflow without pulling media or annotation persistence forward. Later team-management mutations may reuse existing teams; they do not change this atomic first-match onboarding contract.
