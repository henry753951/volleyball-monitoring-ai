# ADR 0037: Versioned ReID evidence and capability-gated provider work

Status: Accepted

Date: 2026-08-15

Supersedes: ADR 0035 for active ReID writes and runtime behavior

## Context

ADR 0035 couples four appearance descriptors, earlier-clip fitting, fixed S1-S6 identity, and
effective player projection to the completed AnalysisRun callback transaction. Production use reports
substantially lower cross-clip accuracy than the controlled evaluation, same-clip grouping can also be
wrong, and an automatic error can become later fitting history without a first-class eligibility
decision. A ReID exception can prevent otherwise valid analysis data from becoming visible.

The external engine also has overlapping pose consumers: prompted KPR, jersey/VLM frame selection,
and contact actor association. Sampling pose only near an existing contact would make a later manual
contact-time edit require an unexpected model rerun.

The accepted implementation plan is
[`ANNOTATION_WORKSTATION_USER_FLOWS_AND_REID_EVOLUTION.md`](../ANNOTATION_WORKSTATION_USER_FLOWS_AND_REID_EVOLUTION.md).

## Decision

### Identity and evidence

- Track IDs remain AnalysisRun-local. They are never a cross-clip identity key.
- Cross-clip machine identity is an unbounded match/team-scoped person cluster. Roster assignment,
  physical court side, lineup state, and the at-most-six simultaneously visible constraint are
  separate facts.
- Raw AnalysisData, tracks, crops, pose, descriptors, VLM responses, and source manifests are
  immutable evidence. Human repair changes versioned membership, association, or effective
  projection; it never edits the evidence bytes.
- Evidence membership has explicit `UNVERIFIED`, `CONFIRMED`, `REJECTED`, and `QUARANTINED` states.
  Only the supplied immutable eligible-bank snapshot may influence one association run.
- Association may abstain as `UNRESOLVED` or `NEEDS_REVIEW`. Manual effective assignments always win
  over automatic projections.
- A correction records display scope and future-evidence action independently. By default it does not
  rewrite an earlier approved clip. It produces a new bank revision for explicitly selected current or
  future rematching.

### Every-frame person pose and hitter association

- Base `ANALYSIS` produces person COCO-17 pose for every canonical frame and every visible/tracked
  player observation in that frame. Each tuple
  `(analysis_run, canonical_frame, track, pose_recipe)` has either one immutable observation or one
  explicit missing/failure reason.
- Pose evidence records video-space keypoints/confidence, source bbox, crop transform, detector versus
  tracker source, model/checkpoint/preprocess namespace, and content hash. It is chunked by canonical
  frame range in object storage; GraphQL and WebSockets expose only bounded manifests/status.
- ReID/VLM may select bounded high-quality frames after full pose production. This downstream frame
  selection does not reduce pose coverage.
- Moving a manual contact reads persisted exact-frame pose, ball, action, and bbox evidence and
  deterministically recalculates actor association. It does not enqueue detector, tracker, pose, or
  ReID inference. Reliable wrist/forearm-to-ball geometry is primary; missing, weak, or ambiguous pose
  degrades to action-aware bbox, generic bbox, then unresolved/no-player.
- Rebuilding absent/corrupt pose or selecting a new pose namespace is a separate explicit evidence
  job/version. A ReID job never starts pose implicitly.

### Durable provider work

Provider transport becomes a common durable envelope with a discriminated `work_kind`:

- `ANALYSIS`: detector/tracker/court/ball/action, every-frame pose evidence, AnalysisData, and initial
  pose-first contact association;
- `REID_FEATURE_EXTRACTION`: versioned DINO/OSNet/KPR/KPR Prompt/VLM evidence from one immutable
  AnalysisEvidenceBundle;
- `REID_ASSOCIATION`: grouping, constrained retrieval/fitting, roster candidate scoring, and
  abstention against one immutable bank and roster snapshot; and
- `PERSON_POSE_EVIDENCE_REBUILD`: an explicit repair/new-recipe path, never a hidden consequence of
  contact editing or ReID.

Identity preview materialization is deterministic Central/worker media work and is not an identity
model job.

The public version decisions are:

- Provider Realtime `2.0.0` is the new discriminated control protocol. It uses `provider_job_id`,
  `work_kind`, request schema version/hash, lease/delivery identity, and artifact references.
- Provider Capabilities `3.0.0` advertises supported `(work_kind, request_schema_version,
result_schema_version)` tuples, artifact kinds, model/recipe namespaces, hardware requirements, and
  concurrency per work kind.
- Existing Analysis Job `3.0.0` remains the `ANALYSIS` payload during migration.
- Provider Work Envelope, ReID Feature Job/Result, ReID Association Job/Result, Analysis Evidence
  Manifest, Person Pose Evidence Manifest, and preview manifest begin at `1.0.0`. The initially
  drafted eligible bank snapshot `1.0.0` was not executable because vector IDs had no artifact byte
  locations and an empty evidence bank had no stable cluster/roster candidate index. It is
  superseded before rollout by bank snapshot `1.1.0`, which makes both mappings explicit.
  Association Job `1.0.0` is likewise superseded before rollout by `1.1.0`: a team-scoped bank
  now carries an explicit non-empty `eligible_tracklet_ids` list, preventing two side-specific
  association runs from producing competing decisions for the same current tracklet. Tracklets
  whose court side remains unknown abstain into human review instead of being guessed into a team.
  Identity Preview Job `1.0.0` is superseded before rollout by `1.1.0`: the original request did not
  map the database tracklet UUID to its canonical analysis track ID and did not identify the saved
  pose manifest, so a worker could not deterministically crop the requested person without hidden
  database knowledge or rerunning pose. Version `1.1.0` makes both references explicit.

WebSocket is control-plane only. Media, pose chunks, descriptors, bank bundles, result artifacts, and
previews use independently authorized signed HTTP/object endpoints with checksums. Workers do not
receive database credentials.

### Vector storage and later clips

- A content-addressed immutable ReID evidence artifact in managed object storage is the source of truth
  for complete per-modality vectors and source provenance.
- PostgreSQL stores artifact metadata/hashes, namespaces, memberships, corrections, immutable bank
  snapshot manifests, association decisions/runs, and active projection revisions.
- Central creates a later clip's bank snapshot from eligible earlier memberships as of an explicit
  canonical position/revision. The association job receives signed URLs and hashes for current
  evidence, that exact bank snapshot, and a roster/constraint snapshot.
- Bank snapshot `1.1.0` enumerates each eligible person cluster and optional match-roster entry, and
  maps every referenced vector ID to one immutable descriptor artifact, model namespace, modality,
  dimension, metric, byte range, and checksum. A worker must reject missing/overlapping/out-of-range
  mappings; it must never infer offsets from membership order or central database state.
- pgvector is optional measured retrieval infrastructure for compatible low-dimensional copies such as
  DINO 384-D and OSNet 512-D. It is not the only vector copy, evidence authority, correction store, or
  identity decision engine. The 4096-D KPR paths remain in immutable artifacts and reproducible worker
  scoring unless an evaluated representation is accepted later.

### Persistence and audit

The target persistence model contains generic provider jobs, immutable analysis/evidence artifacts,
ReID evidence sets/tracklets/vectors, person clusters, positive and negative memberships, eligible bank
snapshots, association runs/decisions, append-only corrections, assignment revisions, active
projections, and preview assets. A materialized current projection may exist for reads but must be
reproducible from immutable inputs and revisions.

Feature rebuild and association rerun are explicit idempotent request records. A feature rebuild
creates a new evidence generation and activates it only after exact canonical-track coverage
validation; a rerun reuses the same immutable evidence and eligible-bank inputs. Generations and runs
are superseded rather than overwritten.

Association materialization checks the newest applicable bank revision, so a delayed old provider
result remains auditable but cannot update the active projection. Rebuilding feature evidence carries
forward semantic-track manual projections and supersedes eligible positive/negative memberships with
rows for the new descriptor generation at a new identity revision. It never reruns Pose implicitly.

`ReidIdentity`, fixed S1-S6 slot fitting, `ReidPlayerBinding`, and automatic in-callback propagation are
legacy read/export paths only after cutover. Legacy automatic observations migrate as unverified
evidence; validated manual Local/TID assignments may migrate as confirmed revisions with provenance.

### Capability-gated cutover

Central may temporarily read Provider Realtime 1.0/Capabilities 2.0 and the new versions, but it sends
each worker only a work kind/schema tuple that worker advertised. Rollout order is:

1. deploy new readers, contracts, and generic persistence;
2. deploy capability-advertising workers;
3. run shadow feature/association jobs with no active projection writes;
4. enable new ReID writes and retain manual-assignment precedence;
5. stop legacy fixed-slot callback fitting and automatic propagation; and
6. remove obsolete runtime/UI paths after reconciliation and rollback-export verification.

New production ReID writes use only the new architecture after activation; dual-write is not
indefinite. Historical AnalysisData, descriptors, completed jobs, exports, and human decisions remain
readable/exportable. Migration performs no destructive deletion.

## Public field ownership

| Field group                                                 | Producer                          | Consumer                               | Ownership/failure rule                                                     |
| ----------------------------------------------------------- | --------------------------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| `provider_job_id`, `work_kind`, schema/hash, lease/delivery | Central                           | Worker/Central                         | Central passthrough; mismatch rejects the result                           |
| signed media/artifact URLs                                  | Central storage boundary          | Worker                                 | Independently authorized, expiring, never combined with callback token     |
| AnalysisData and pose/evidence artifacts                    | External engine                   | Central/ReID workers                   | AI-generated immutable evidence; checksum/schema failures are explicit     |
| roster, side, lineup, bank snapshots                        | Central                           | ReID workers                           | Immutable Central snapshots; workers cannot rewrite domain truth           |
| descriptors and VLM observations                            | ReID feature worker               | Central/association worker             | Immutable namespaced evidence with source/hash provenance                  |
| association candidates/decisions                            | ReID association worker           | Central                                | Immutable inference; may abstain and never directly overwrite manual state |
| membership/correction/projection                            | Authorized Central domain command | Replay/analytics/ReID snapshot builder | Append-only revisioned domain authority                                    |

## Consequences

- A valid AnalysisRun is committed and visible even if feature extraction or association fails.
- Feature extraction, association, preview regeneration, and explicit pose rebuild have independent
  retry/idempotency and can be rerun without changing immutable submissions.
- Full every-frame pose increases GPU time and artifact storage. Streaming/batched inference, chunked
  binary artifacts, coverage manifests, capacity measurement, and explicit missing reasons control the
  cost without weakening editability.
- The contributor VLM/pose branch is used as an algorithm/test source and refactored behind the new job
  boundary; it is not merged unchanged and its private evaluation claims are not treated as production
  evidence.
- Contract fixtures, SDK models, server validators/routing, database migrations, worker dispatch, Web
  UI, exports, and operational documentation must migrate together before activation.
