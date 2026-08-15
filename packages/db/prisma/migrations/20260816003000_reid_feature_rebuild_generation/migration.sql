ALTER TABLE "ReidEvidenceSet"
ADD COLUMN "supersededAt" TIMESTAMP(3),
ADD COLUMN "supersededByEvidenceSetId" UUID;

ALTER TABLE "ReidEvidenceSet"
ADD CONSTRAINT "ReidEvidenceSet_supersededByEvidenceSetId_fkey"
FOREIGN KEY ("supersededByEvidenceSetId") REFERENCES "ReidEvidenceSet"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ReidEvidenceSet_analysisRunId_supersededAt_createdAt_idx"
ON "ReidEvidenceSet"("analysisRunId", "supersededAt", "createdAt");

CREATE INDEX "ReidEvidenceSet_supersededByEvidenceSetId_idx"
ON "ReidEvidenceSet"("supersededByEvidenceSetId");

CREATE TABLE "ReidFeatureRebuildRequest" (
  "id" UUID NOT NULL,
  "analysisRunId" UUID NOT NULL,
  "requestedByUserId" UUID NOT NULL,
  "providerJobId" UUID,
  "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
  "reason" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ReidFeatureRebuildRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReidFeatureRebuildRequest_providerJobId_key"
ON "ReidFeatureRebuildRequest"("providerJobId");

CREATE INDEX "ReidFeatureRebuildRequest_status_createdAt_idx"
ON "ReidFeatureRebuildRequest"("status", "createdAt");

CREATE INDEX "ReidFeatureRebuildRequest_analysisRunId_createdAt_idx"
ON "ReidFeatureRebuildRequest"("analysisRunId", "createdAt");

ALTER TABLE "ReidFeatureRebuildRequest"
ADD CONSTRAINT "ReidFeatureRebuildRequest_analysisRunId_fkey"
FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReidFeatureRebuildRequest"
ADD CONSTRAINT "ReidFeatureRebuildRequest_requestedByUserId_fkey"
FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReidFeatureRebuildRequest"
ADD CONSTRAINT "ReidFeatureRebuildRequest_providerJobId_fkey"
FOREIGN KEY ("providerJobId") REFERENCES "ProviderJob"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
