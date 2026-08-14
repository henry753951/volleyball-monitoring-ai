# ADR 0035: Fixed-roster Nested Part Adaptation

Status: accepted
Date: 2026-08-14
Supersedes: ADR 0033

## Decision

ReID uses the `volley-reid` fixed-roster identity contract. Tracker IDs remain local to one
AnalysisRun. Match identity is bounded to six team slots per team; the physical overlay label is
derived at presentation time as `L1..L6` or `R1..R6`. A side swap changes the physical prefix,
not the team slot or its player binding. Slots are unique by match, team, and index rather than
by appearance-model version, so upgrading one descriptor model cannot create a second roster.
The system never creates sequential or seventh GIDs.

The Worker emits `AnalysisData.extensions.fixed_roster_reid` v2. Each canonical tracklet retains
all TID aliases, court-side/median-position evidence, symmetric co-visibility cannot-links, and
four frozen multi-frame descriptors:

- DINOv2 ViT-S/14 Reg global appearance (384-D);
- Sports OSNet-x1.0 person appearance (512-D);
- Official KPR visible-part appearance (4096-D);
- Official KPR prompted by COCO-17 pose, with explicit prompt-free fallback (4096-D).

The large frozen models are not fine-tuned. For fewer than three earlier clips, KPR Prompt is the
fixed fallback. Once enough earlier clips exist, central selects modality subset, kernel, and
regularization by Nested Leave-One-Clip-Out using earlier match clips only, then fits a same-team
Kernel Ridge head. The current query clip is never used for parameter selection or training.

## Compatibility

This is an intentional hard cut. The v1 `reid_feature_bank`, unbounded `G###` identities, and their
derived persistence rows are removed. The migration preserves independent manual roster
assignments but clears v1-derived identity links. New results must advertise
`optional_extensions.fixed_roster_reid` and emit v2.

## Human corrections

Immutable AnalysisData is retained. The canonical player assignment is always persisted per
run-local track as `(analysis_run_id, track_id) -> roster_entry_id`; GID is not the player-assignment
primary key. The UI may group multiple Local/TIDs by one fixed team slot and batch-apply one player,
but this writes one `TrackIdentityAssignment` for every Local/TID. A Local-only correction remains
possible when ReID grouped a track incorrectly.

A match-scoped GID binding records which player a fixed slot represented from one set/rally onward.
It assists automatic assignment for later clips and can be manually re-applied to an existing run,
but it never replaces the Local/TID assignments consumed by events, replay or analytics. Manual
assignments take precedence over automatic propagation. It cannot create a new identity. Dataset
exports include the raw v2 tracklet payload, separated
JSONL persistence/binding/correction views, descriptor hashes, recipe, selection parameters, and
source clip metadata.

## Evidence

The adopted recipe is the strict cross-clip `exp_0017_offline_china_reid` result from
`H:\Repos\volley-reid`: Nested Part Adaptation achieved 104/137 (75.91%) Top-1; the strongest fixed
single path, KPR Prompt, achieved 99/137 (72.26%). The 75.91% result selected different candidates
across outer folds, so it must not be represented as one frozen model configuration.
