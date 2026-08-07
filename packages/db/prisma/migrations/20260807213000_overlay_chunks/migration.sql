CREATE TABLE "OverlayManifest" (
    "analysisRunId" UUID NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "overlayVersion" TEXT NOT NULL,
    "videoWidth" INTEGER NOT NULL,
    "videoHeight" INTEGER NOT NULL,
    "fpsNum" INTEGER NOT NULL,
    "fpsDen" INTEGER NOT NULL,
    "totalFrames" BIGINT NOT NULL,
    "chunkFrameCount" INTEGER NOT NULL,
    "actionTaxonomy" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OverlayManifest_pkey" PRIMARY KEY ("analysisRunId")
);

CREATE TABLE "OverlayChunk" (
    "analysisRunId" UUID NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "startFrameIndex" BIGINT NOT NULL,
    "frameCount" INTEGER NOT NULL,
    "assetId" UUID NOT NULL,
    "byteLength" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OverlayChunk_pkey" PRIMARY KEY ("analysisRunId", "chunkIndex")
);

CREATE UNIQUE INDEX "OverlayChunk_assetId_key" ON "OverlayChunk"("assetId");
CREATE INDEX "OverlayChunk_analysisRunId_startFrameIndex_idx" ON "OverlayChunk"("analysisRunId", "startFrameIndex");

ALTER TABLE "OverlayManifest" ADD CONSTRAINT "OverlayManifest_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OverlayChunk" ADD CONSTRAINT "OverlayChunk_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "OverlayManifest"("analysisRunId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OverlayChunk" ADD CONSTRAINT "OverlayChunk_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
