# ADR 0015: Remove Saved Analysis Views before 1.0

Status: Accepted — 2026-08-08

The product owner removed Saved Analysis Views from the coach experience because the named filter/layout persistence duplicated navigation, consumed limited iPad space and exposed configuration that is not needed during a match. Coach analytics continue to recompute from the current immutable submissions, active AnalysisRuns and current identity mappings every time a page opens.

This pre-1.0 decision removes `savedAnalysisViews` and `saveAnalysisView` from the GraphQL schema, deletes their stored operations and consumers, and removes the unused server service and `SavedAnalysisView` Prisma model. The local database contained zero saved-view rows before the removal migration was authored, so no user data required export or preservation. Migration `20260808110000_remove_saved_analysis_views` drops only that table.

This is an intentional breaking removal from the unpublished GraphQL surface. The AI REST callback, media APIs, Annotation WebSocket, normalized analysis schema and Python SDK do not change. Reintroducing saved views later requires a new product decision, additive contract and independent data model rather than reviving this obsolete API silently.
