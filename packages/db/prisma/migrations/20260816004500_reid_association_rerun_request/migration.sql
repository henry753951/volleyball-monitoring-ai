CREATE TABLE "ReidAssociationRerunRequest" (
  "id" UUID NOT NULL,
  "analysisRunId" UUID NOT NULL,
  "requestedByUserId" UUID NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
  "reason" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ReidAssociationRerunRequest_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ReidAssociationRun" ADD COLUMN "rerunRequestId" UUID;

CREATE INDEX "ReidAssociationRerunRequest_status_createdAt_idx"
ON "ReidAssociationRerunRequest"("status", "createdAt");

CREATE INDEX "ReidAssociationRerunRequest_analysisRunId_createdAt_idx"
ON "ReidAssociationRerunRequest"("analysisRunId", "createdAt");

CREATE INDEX "ReidAssociationRun_rerunRequestId_idx"
ON "ReidAssociationRun"("rerunRequestId");

ALTER TABLE "ReidAssociationRerunRequest"
ADD CONSTRAINT "ReidAssociationRerunRequest_analysisRunId_fkey"
FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReidAssociationRerunRequest"
ADD CONSTRAINT "ReidAssociationRerunRequest_requestedByUserId_fkey"
FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReidAssociationRun"
ADD CONSTRAINT "ReidAssociationRun_rerunRequestId_fkey"
FOREIGN KEY ("rerunRequestId") REFERENCES "ReidAssociationRerunRequest"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
