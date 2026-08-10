ALTER TABLE "AnalysisBallCorrection"
  ALTER COLUMN "frameX" DROP NOT NULL,
  ALTER COLUMN "frameY" DROP NOT NULL,
  ADD COLUMN "visible" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "AnalysisPlayerBBoxCorrection" (
  "analysisRunId" UUID NOT NULL,
  "frameIndex" BIGINT NOT NULL,
  "trackId" INTEGER NOT NULL,
  "frameX1" DOUBLE PRECISION NOT NULL,
  "frameY1" DOUBLE PRECISION NOT NULL,
  "frameX2" DOUBLE PRECISION NOT NULL,
  "frameY2" DOUBLE PRECISION NOT NULL,
  "revision" BIGINT NOT NULL,
  "updatedByUserId" UUID NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AnalysisPlayerBBoxCorrection_pkey" PRIMARY KEY ("analysisRunId", "frameIndex", "trackId")
);

CREATE TABLE "AnalysisContactActorCorrection" (
  "analysisRunId" UUID NOT NULL,
  "keyPointId" UUID NOT NULL,
  "trackId" INTEGER,
  "revision" BIGINT NOT NULL,
  "updatedByUserId" UUID NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AnalysisContactActorCorrection_pkey" PRIMARY KEY ("analysisRunId", "keyPointId")
);

CREATE INDEX "AnalysisPlayerBBoxCorrection_analysisRunId_revision_idx"
  ON "AnalysisPlayerBBoxCorrection"("analysisRunId", "revision");
CREATE INDEX "AnalysisContactActorCorrection_analysisRunId_revision_idx"
  ON "AnalysisContactActorCorrection"("analysisRunId", "revision");

ALTER TABLE "AnalysisPlayerBBoxCorrection"
  ADD CONSTRAINT "AnalysisPlayerBBoxCorrection_analysisRunId_fkey"
  FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AnalysisContactActorCorrection"
  ADD CONSTRAINT "AnalysisContactActorCorrection_analysisRunId_fkey"
  FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AnalysisContactActorCorrection"
  ADD CONSTRAINT "AnalysisContactActorCorrection_analysisRunId_keyPointId_fkey"
  FOREIGN KEY ("analysisRunId", "keyPointId") REFERENCES "ContactEvent"("analysisRunId", "keyPointId") ON DELETE CASCADE ON UPDATE CASCADE;
