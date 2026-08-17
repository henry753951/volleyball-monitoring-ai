# ADR 0047: Capped team GIDs and bounded ReID rerun wait

Status: Accepted

Date: 2026-08-17

Amends: ADR 0037 and ADR 0044 where they define match-long GIDs as unbounded or allow every weak
association to persist a new active GID.

## Context

The active-unbound policy persisted every Provider `CREATE_NEW_GID` response. Automatic
`UNVERIFIED` history was then excluded from later bank snapshots, so later clips often had no usable
automatic history and created another GID for the same visual player. A production match accumulated
hundreds of team GIDs even though no frame showed more than six players for that team.

The operator-facing "use existing data to rematch" action also created a durable Provider request and
polled it without a foreground deadline. Duplicate requests for the same analysis/revision were
allowed because their nullable revision key was never populated. One running request waiting on a
Provider could starve every later queued request in the workflow scheduler.

## Decision

- Each team has a persistent baseline pool of at most six GIDs.
- Central may persist GID seven or later only when the current immutable evidence proves that many
  same-team Local tracklets on one canonical frame. Fragments accumulated at different frames do not
  increase the cap.
- Provider `CREATE_NEW_GID` is a proposal, not permission to insert a cluster. Once the allowed pool
  is full, Central reuses the best legal candidate from the existing pool while respecting exact-frame
  cannot-links. The calculation stays in memory until the final assignments are materialized.
- Earlier vector-bearing automatic `UNVERIFIED` memberships are eligible low-weight association
  history. Current-rally automatic output cannot seed its own run; human `CONFIRMED` evidence remains
  higher authority and manual projections remain immutable to automatic reruns.
- `court_side=UNKNOWN` Local tracklets remain without a team GID until team evidence or a human
  assignment exists. They do not create team-null persistent GIDs.
- One `analysis_run` has at most one `QUEUED` or `RUNNING` rerun request. Concurrent or repeated UI
  requests receive that active canonical request ID even if the match identity revision advanced
  while its Provider job was waiting. After it finishes, `(analysis_run, identity_revision)` remains
  the durable idempotency key; failed or cancelled requests may be requeued.
- A running request with all required Provider jobs already scheduled cannot block another actionable
  request. The UI stops foreground polling after 30 seconds and clearly states that background work
  may continue; success, failure, cancellation, timeout, and loss of status connectivity all end the
  spinner.

## Consequences

- New automatic association writes cannot grow a team's persistent GID count past six without
  same-frame overflow evidence.
- Existing excessive GID rows remain auditable history; this decision does not destructively delete or
  silently merge prior evidence. Reruns progressively project current Local IDs onto the capped pool.
- Automatic history can now help later clips match the existing pool, but it retains its lower
  `UNVERIFIED` weight and never overrides manual work.
- Provider result schemas remain compatible. Central applies the hard persistence gate after validating
  the immutable Provider result and records the effective capped decision.
