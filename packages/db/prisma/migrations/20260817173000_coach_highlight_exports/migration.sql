ALTER TYPE "MediaAssetKind" ADD VALUE IF NOT EXISTS 'HIGHLIGHT_REEL';

CREATE TABLE "CoachHighlightExportJob" (
  "id" UUID NOT NULL,
  "matchId" UUID NOT NULL,
  "requestedByUserId" UUID NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
  "idempotencyKey" TEXT NOT NULL,
  "schemaVersion" TEXT NOT NULL DEFAULT '1.0.0',
  "requestPayload" JSONB NOT NULL,
  "progress" INTEGER NOT NULL DEFAULT 0,
  "outputAssetId" UUID,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leasedUntil" TIMESTAMP(3),
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CoachHighlightExportJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CoachHighlightExportJob_idempotencyKey_key"
  ON "CoachHighlightExportJob"("idempotencyKey");
CREATE INDEX "CoachHighlightExportJob_status_availableAt_createdAt_idx"
  ON "CoachHighlightExportJob"("status", "availableAt", "createdAt");
CREATE INDEX "CoachHighlightExportJob_matchId_createdAt_idx"
  ON "CoachHighlightExportJob"("matchId", "createdAt");

ALTER TABLE "CoachHighlightExportJob"
  ADD CONSTRAINT "CoachHighlightExportJob_matchId_fkey"
  FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CoachHighlightExportJob"
  ADD CONSTRAINT "CoachHighlightExportJob_requestedByUserId_fkey"
  FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CoachHighlightExportJob"
  ADD CONSTRAINT "CoachHighlightExportJob_outputAssetId_fkey"
  FOREIGN KEY ("outputAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
