CREATE TYPE "AnalysisReviewStatus" AS ENUM ('EDITING', 'READY', 'APPROVED');

ALTER TABLE "AnalysisRun"
ADD COLUMN "reviewStatus" "AnalysisReviewStatus" NOT NULL DEFAULT 'EDITING',
ADD COLUMN "reviewComputedRevision" BIGINT,
ADD COLUMN "reviewComputedAt" TIMESTAMP(3),
ADD COLUMN "reviewApprovedRevision" BIGINT,
ADD COLUMN "reviewApprovedAt" TIMESTAMP(3),
ADD COLUMN "reviewApprovedByUserId" UUID;

-- Existing completed analyses were already visible to coaches before review
-- publishing existed. Preserve that behaviour while requiring explicit review
-- for every analysis created after this migration.
UPDATE "AnalysisRun"
SET "reviewStatus" = 'APPROVED',
    "reviewComputedRevision" = "reviewRevision",
    "reviewComputedAt" = COALESCE("activatedAt", "createdAt"),
    "reviewApprovedRevision" = "reviewRevision",
    "reviewApprovedAt" = COALESCE("activatedAt", "createdAt")
WHERE "status" = 'COMPLETED';

CREATE TABLE "AnalysisContactEdit" (
    "analysisRunId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "baseKeyPointId" UUID,
    "frameIndex" BIGINT NOT NULL,
    "trackId" INTEGER,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "revision" BIGINT NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AnalysisContactEdit_pkey" PRIMARY KEY ("analysisRunId", "contactId")
);

CREATE INDEX "AnalysisContactEdit_analysisRunId_revision_idx" ON "AnalysisContactEdit"("analysisRunId", "revision");
CREATE INDEX "AnalysisContactEdit_analysisRunId_frameIndex_idx" ON "AnalysisContactEdit"("analysisRunId", "frameIndex");

CREATE TABLE "CourtSideSwapMarker" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "setId" UUID NOT NULL,
    "captureSessionId" UUID NOT NULL,
    "captureEpochId" UUID NOT NULL,
    "sourcePts" BIGINT NOT NULL,
    "captureTimeUs" BIGINT NOT NULL,
    "captureFrameIndex" BIGINT NOT NULL,
    "timingPrecision" "TimingPrecision" NOT NULL,
    "originalPlaybackCursor" JSONB NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CourtSideSwapMarker_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CourtSideSwapMarker_matchId_captureTimeUs_idx" ON "CourtSideSwapMarker"("matchId", "captureTimeUs");
CREATE INDEX "CourtSideSwapMarker_setId_captureTimeUs_idx" ON "CourtSideSwapMarker"("setId", "captureTimeUs");
CREATE UNIQUE INDEX "CourtSideSwapMarker_captureSessionId_captureTimeUs_key" ON "CourtSideSwapMarker"("captureSessionId", "captureTimeUs");

ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_reviewApprovedByUserId_fkey"
FOREIGN KEY ("reviewApprovedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AnalysisContactEdit" ADD CONSTRAINT "AnalysisContactEdit_analysisRunId_fkey"
FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CourtSideSwapMarker" ADD CONSTRAINT "CourtSideSwapMarker_matchId_fkey"
FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CourtSideSwapMarker" ADD CONSTRAINT "CourtSideSwapMarker_setId_fkey"
FOREIGN KEY ("setId") REFERENCES "MatchSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CourtSideSwapMarker" ADD CONSTRAINT "CourtSideSwapMarker_captureSessionId_fkey"
FOREIGN KEY ("captureSessionId") REFERENCES "CaptureSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CourtSideSwapMarker" ADD CONSTRAINT "CourtSideSwapMarker_captureEpochId_fkey"
FOREIGN KEY ("captureEpochId") REFERENCES "CaptureEpoch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CourtSideSwapMarker" ADD CONSTRAINT "CourtSideSwapMarker_createdByUserId_fkey"
FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
