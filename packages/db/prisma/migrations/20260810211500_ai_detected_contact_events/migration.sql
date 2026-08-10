ALTER TABLE "ContactEvent"
ADD COLUMN "sourceKeyPointId" UUID,
ADD COLUMN "anchorOrigin" TEXT NOT NULL DEFAULT 'human_anchor',
ADD COLUMN "detectionConfidence" DOUBLE PRECISION,
ADD COLUMN "detectionEvidence" JSONB;

UPDATE "ContactEvent"
SET "sourceKeyPointId" = "keyPointId";

ALTER TABLE "ContactEvent"
DROP CONSTRAINT "ContactEvent_keyPointId_fkey";

ALTER TABLE "ContactEvent"
ADD CONSTRAINT "ContactEvent_sourceKeyPointId_fkey"
FOREIGN KEY ("sourceKeyPointId") REFERENCES "RallySubmissionKeyPoint"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ContactEvent_sourceKeyPointId_idx"
ON "ContactEvent"("sourceKeyPointId");

CREATE TABLE "AnalysisContactTimeCorrection" (
    "analysisRunId" UUID NOT NULL,
    "keyPointId" UUID NOT NULL,
    "frameIndex" BIGINT NOT NULL,
    "revision" BIGINT NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalysisContactTimeCorrection_pkey" PRIMARY KEY ("analysisRunId","keyPointId")
);

CREATE INDEX "AnalysisContactTimeCorrection_analysisRunId_revision_idx"
ON "AnalysisContactTimeCorrection"("analysisRunId", "revision");

ALTER TABLE "AnalysisContactTimeCorrection"
ADD CONSTRAINT "AnalysisContactTimeCorrection_analysisRunId_fkey"
FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AnalysisContactTimeCorrection"
ADD CONSTRAINT "AnalysisContactTimeCorrection_analysisRunId_keyPointId_fkey"
FOREIGN KEY ("analysisRunId", "keyPointId") REFERENCES "ContactEvent"("analysisRunId", "keyPointId") ON DELETE CASCADE ON UPDATE CASCADE;
