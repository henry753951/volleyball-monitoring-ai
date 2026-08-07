-- Immutable overlay bytes may be referenced by a cloned AnalysisRun when an
-- outcome-only correction reuses identical AI geometry.
DROP INDEX "OverlayChunk_assetId_key";
CREATE INDEX "OverlayChunk_assetId_idx" ON "OverlayChunk"("assetId");
