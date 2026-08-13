# ADR 0031: Rally boundaries and effective contact analysis

Status: Accepted

## Context

Annotation protocol 2.2 overloaded key points with three unrelated meanings. The
first Z created a `SERVICE` key point, the second Z created a terminal `CONTACT`,
and score resolution also closed the Rally. Those synthetic events were copied
into immutable submissions and AI jobs, so segment boundaries could be mistaken
for ball contacts, hitters, landings, or path endpoints.

Operators need to mark a bounded video segment without asserting a serve,
landing, winner, or contact. Human contacts are optional X annotations. An AI
provider may discover additional contacts, and reviewers may correct those
contacts without rerunning detector or tracker inference.

## Decision

- Annotation protocol 3.0 adds `START_RALLY` and `END_RALLY`. Both resolve a
  canonical media anchor on the server and persist a `RallyBoundary`; neither
  command creates a key point.
- Z toggles `START_RALLY`/`END_RALLY`. X remains the only manual contact command.
- An OPEN Rally owns a start boundary. A READY Rally owns both start and end
  boundaries. At most one ordinary Rally is OPEN per match, while any number of
  READY, unsubmitted Rallies may coexist.
- Score resolution is optional metadata. A bounded Rally may be submitted with
  `PENDING`, `RESOLVED`, or `UNKNOWN` score resolution.
- Immutable submissions snapshot boundaries independently from contact key
  points. Clip geometry uses boundaries; AI input uses boundaries as coverage
  and key points only as optional manual-contact hints.
- Pre/post-roll overlap is not an annotation integrity error. Adjacent clips may
  share media while their canonical Rally boundaries remain distinct.
- An OPEN mask follows the local browser cursor without network writes. Only the
  two Z commands create canonical shared anchors.
- Provider output remains immutable. Review corrections form an effective
  analysis revision; contact association and dependent path/coach projections
  are rebuilt from persisted tracks and ball observations rather than rerunning
  inference.
- Protocol 2.x commands and historical service/terminal rows remain readable
  during migration. New clients write protocol 3.0 only.

## Migration

- Legacy `SERVICE` and terminal points remain readable through the protocol 2.x
  projection. The database migration does not guess v3 boundaries from those
  overloaded historical rows.
- A deliberate later migration may create boundaries only when provenance is
  sufficient to distinguish synthetic end markers from genuine contacts.
- Historical submissions and AI artifacts are not rewritten. New submissions
  snapshot v3 boundaries and contain only manually asserted X contacts.

## Consequences

- Zero-contact Rally submissions are valid and may rely entirely on automatic
  contact detection.
- Boundary edits require a correction submission; analysis-only corrections do
  not mutate immutable submissions.
- Consumers must distinguish structural segment completion from contact and
  scoring semantics.
