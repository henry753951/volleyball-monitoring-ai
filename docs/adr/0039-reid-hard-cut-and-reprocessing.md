# ADR 0039: ReID hard cut and independent reprocessing

Status: Accepted

Date: 2026-08-16

Supersedes: ADR 0035 completely, and ADR 0037's migration-only compatibility steps

## Context

The versioned ReID architecture is intended to support low-confidence cross-rally association,
same-rally mistakes, human correction, evidence quarantine, later rematching, dynamic identity
previews, and independently rerunnable feature jobs. Keeping the earlier fixed S1-S6 identity tables,
callback fitting, UI labels, and export format creates two authorities for the same player assignment.
The historical rally/ReID data is explicitly disposable for this cutover.

## Decision

- Provider Work Realtime 2 and versioned `ProviderJob` work kinds are the only active provider
  transport. The server no longer registers the legacy AI callback or provider WebSocket routes.
- Base `ANALYSIS` owns canonical AnalysisData and every-frame pose. It never performs fixed-roster
  fitting. `REID_FEATURE_EXTRACTION`, `REID_ASSOCIATION`, and identity preview are independent jobs.
- `ReidEvidenceSet`, `ReidTracklet`, immutable descriptor artifacts, `ReidPersonCluster`, versioned
  memberships, association runs/decisions, corrections, assignment revisions, and active projections
  are the only ReID authority.
- `TrackIdentityAssignment` remains only as a materialized read projection for current UI/analytics.
  It stores roster, source, confidence, and identity revision; it has no legacy GID or binding foreign
  keys and can always be rebuilt from `ReidActiveProjection`.
- `ReidIdentity`, `ReidFeatureObservation`, `ReidPlayerBinding`, `ReidCorrectionEvent`, the fixed
  roster contract/fixture/SDK models, and their database data are deleted. There is no fallback read,
  dual write, migration import, or legacy export.
- Reprocessing reuses a verified READY canonical clip and creates a new `ProviderJob(ANALYSIS)`.
  Provider-job UUIDs supply compact idempotency keys that remain within the protocol's 128-character
  bound. A rerun does not recut media and does not make the previous completed AnalysisRun disappear
  until the replacement materializes successfully.
- VLM is capability-gated. When disabled, a worker neither initializes nor advertises VLM and must
  still complete analysis, every-frame pose, non-VLM ReID features, association, and preview work.

## Data reset and rollout

The migration drops the four legacy ReID tables and two legacy columns on
`TrackIdentityAssignment`. Existing versioned evidence may also be cleared per match when a clean
reprocessing baseline is required. Canonical clips and immutable rally submissions are retained so
analysis can be resubmitted without media loss.

Deployment order is atomic:

1. stop legacy provider workers and ensure no old callback is in flight;
2. deploy the schema migration, server, workflow workers, and web consumers together;
3. start only capability-advertising Provider Realtime 2 workers;
4. reprocess selected rallies with base analysis and pose;
5. allow downstream feature, association, and preview jobs to build new evidence; and
6. verify ProviderJob completion, active AnalysisRun projection, ReID evidence coverage, and browser
   replay/identity preview before declaring rollout complete.

## Consequences

- Rollback cannot depend on the deleted fixed-slot data. Recovery uses the retained canonical clips
  and immutable analysis artifacts to rerun the new jobs.
- Export schema `3.0.0` contains versioned evidence tracklets, descriptor byte-range references,
  active projections, and correction lineage. It never emits fixed slots or old bindings.
- A missing versioned evidence set is an explicit `REID_EVIDENCE_PENDING` state, not permission to
  read old rows or display a misleading identity.
