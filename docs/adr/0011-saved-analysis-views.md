# ADR 0011: Versioned per-user Saved Analysis Views

Status: Accepted — 2026-08-07

Saved Analysis Views persist only a named, per-user configuration for an authorized match. The additive GraphQL contract exposes `savedAnalysisViews(matchId)` and `saveAnalysisView(matchId, name, filters, layout)` as versioned JSON read models, with matching stored operation fixtures and a Nuxt consumer. This does not change the REST, media, AI callback or Python SDK boundaries; the Python SDK remains limited to the external AI/media wire contracts and is not a Coach GraphQL consumer.

The saved filter document is a strict whitelist of set/team/roster, Rally outcome, processing, association-quality, zone, provider-action and submitted-time filters. The layout document is limited to the Coach route, overlay mode and visible overlay layers. Metric values, aggregate samples, analysis artifacts and storage identity are rejected rather than snapshotted, so every analytics page continues to recompute from current immutable submissions and active AnalysisRuns.

Each record carries filter schema `1.0.0` and overlay preset `1.0.0`. `(user_id, match_id, name)` is the update boundary: saving the same normalized name replaces that user's configuration without affecting another user. Match members and admins may list/save; unauthorized matches remain not found. Future filter or overlay semantic changes require a new schema/preset version and explicit consumer migration rather than silent reinterpretation.
