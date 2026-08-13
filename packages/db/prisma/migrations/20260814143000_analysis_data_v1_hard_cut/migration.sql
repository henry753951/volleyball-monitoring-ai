-- AnalysisData v1 is a hard cut. AI-derived VOV1/JSON artifacts are removed,
-- while normalized analysis rows and every manual correction remain intact.
ALTER TABLE "AiJob" ALTER COLUMN "jobSchemaVersion" SET DEFAULT '3.0.0';

DELETE FROM "AnalysisArtifact"
WHERE "kind" IN ('ANALYSIS_JSON', 'OVERLAY_SEQUENCE', 'OVERLAY_CHUNK');

DELETE FROM "OverlayChunk";
DELETE FROM "OverlayManifest";

UPDATE "AnalysisRun"
SET "rawAnalysisAssetId" = NULL,
    "rawOverlayAssetId" = NULL;

DELETE FROM "MediaAsset"
WHERE "kind" IN ('ANALYSIS_JSON', 'OVERLAY_SEQUENCE', 'OVERLAY_CHUNK');

ALTER TABLE "AnalysisRun"
  RENAME COLUMN "resultSchemaVersion" TO "analysisDataSchemaVersion";
ALTER TABLE "AnalysisRun"
  RENAME COLUMN "rawAnalysisAssetId" TO "rawAnalysisDataAssetId";
ALTER TABLE "AnalysisRun"
  DROP COLUMN "overlaySchemaVersion",
  DROP COLUMN "rawOverlayAssetId";

ALTER TABLE "OverlayManifest" RENAME TO "AnalysisDataManifest";
ALTER TABLE "AnalysisDataManifest"
  RENAME COLUMN "overlayVersion" TO "analysisDataVersion";
ALTER TABLE "OverlayChunk" RENAME TO "AnalysisFrameChunk";

ALTER TYPE "MediaAssetKind" RENAME TO "MediaAssetKind_old";
CREATE TYPE "MediaAssetKind" AS ENUM (
  'RAW_RECORDING',
  'DVR_INIT',
  'DVR_SEGMENT',
  'SAMPLE_INDEX',
  'CANONICAL_CLIP',
  'PREVIEW_CLIP',
  'TIMING_MANIFEST',
  'ANALYSIS_DATA',
  'ANALYSIS_FRAME_CHUNK'
);
ALTER TABLE "MediaAsset"
  ALTER COLUMN "kind" TYPE "MediaAssetKind"
  USING ("kind"::text::"MediaAssetKind");
ALTER TABLE "AnalysisArtifact"
  ALTER COLUMN "kind" TYPE "MediaAssetKind"
  USING ("kind"::text::"MediaAssetKind");
DROP TYPE "MediaAssetKind_old";
