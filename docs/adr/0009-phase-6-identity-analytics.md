# ADR 0009: Analysis-run identity and evidence-bearing analytics

Status: Accepted — 2026-08-07

Track IDs are never promoted to cross-Rally player identity. A manual identity correction binds exactly one `(analysis_run_id, track_id)` to one roster entry from the same match and records the assigning user and `MANUAL` source. The original AI track remains unchanged.

`coachMatchAnalytics(matchId)` is an authorization-filtered, versioned recomputation over current immutable submissions, active completed AnalysisRuns and current identity mappings. It does not persist stale metric snapshots. Every metric returns `value`, `sample_count`, `excluded_count`, `unknown_count`, `quality_breakdown` and `feature_dependencies`.

Baseline metrics depend only on rally outcome, contact association and external AI court positions. Player metrics appear only after identity mapping. Action-derived metrics remain unavailable until an external provider supplies its optional taxonomy/action extension; a Rally win is never reinterpreted as a direct event-level score.
