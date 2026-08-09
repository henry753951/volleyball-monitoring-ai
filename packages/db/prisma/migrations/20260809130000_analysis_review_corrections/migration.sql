ALTER TABLE "AnalysisRun"
  ADD COLUMN "reviewRevision" BIGINT NOT NULL DEFAULT 0;

CREATE TABLE "AnalysisBallCorrection" (
  "analysisRunId" UUID NOT NULL,
  "frameIndex" BIGINT NOT NULL,
  "frameX" DOUBLE PRECISION NOT NULL,
  "frameY" DOUBLE PRECISION NOT NULL,
  "revision" BIGINT NOT NULL,
  "updatedByUserId" UUID NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AnalysisBallCorrection_pkey" PRIMARY KEY ("analysisRunId", "frameIndex"),
  CONSTRAINT "AnalysisBallCorrection_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AnalysisBallCorrection_analysisRunId_revision_idx"
  ON "AnalysisBallCorrection"("analysisRunId", "revision");

CREATE TABLE "AnalysisActionCorrection" (
  "analysisRunId" UUID NOT NULL,
  "frameIndex" BIGINT NOT NULL,
  "trackId" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "revision" BIGINT NOT NULL,
  "updatedByUserId" UUID NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AnalysisActionCorrection_pkey" PRIMARY KEY ("analysisRunId", "frameIndex", "trackId"),
  CONSTRAINT "AnalysisActionCorrection_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AnalysisActionCorrection_analysisRunId_revision_idx"
  ON "AnalysisActionCorrection"("analysisRunId", "revision");

CREATE TABLE "AnalysisReviewPatchReceipt" (
  "id" UUID NOT NULL,
  "analysisRunId" UUID NOT NULL,
  "revision" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnalysisReviewPatchReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AnalysisReviewPatchReceipt_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AnalysisReviewPatchReceipt_analysisRunId_createdAt_idx"
  ON "AnalysisReviewPatchReceipt"("analysisRunId", "createdAt");
