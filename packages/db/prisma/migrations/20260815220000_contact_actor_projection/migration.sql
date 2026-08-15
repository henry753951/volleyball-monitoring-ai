-- CreateEnum
CREATE TYPE "ContactAssociationSource" AS ENUM ('POSE_HAND', 'BBOX_ACTION', 'BBOX_SPATIAL', 'UNRESOLVED');

-- CreateTable
CREATE TABLE "AnalysisContactAssociationJob" (
    "id" UUID NOT NULL,
    "analysisRunId" UUID NOT NULL,
    "keyPointId" UUID NOT NULL,
    "reviewRevision" BIGINT NOT NULL,
    "frameIndex" BIGINT NOT NULL,
    "algorithmNamespace" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leasedUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalysisContactAssociationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisContactAssociationProjection" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "analysisRunId" UUID NOT NULL,
    "keyPointId" UUID NOT NULL,
    "reviewRevision" BIGINT NOT NULL,
    "frameIndex" BIGINT NOT NULL,
    "observationFrameIndex" BIGINT,
    "trackId" INTEGER,
    "source" "ContactAssociationSource" NOT NULL,
    "confidence" DOUBLE PRECISION,
    "algorithmNamespace" TEXT NOT NULL,
    "poseRecipeNamespace" TEXT,
    "fallbackReason" TEXT,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalysisContactAssociationProjection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContactAssociationJob_run_point_revision_key" ON "AnalysisContactAssociationJob"("analysisRunId", "keyPointId", "reviewRevision");
CREATE INDEX "AnalysisContactAssociationJob_status_availableAt_createdAt_idx" ON "AnalysisContactAssociationJob"("status", "availableAt", "createdAt");
CREATE INDEX "ContactAssociationJob_run_point_revision_idx" ON "AnalysisContactAssociationJob"("analysisRunId", "keyPointId", "reviewRevision");
CREATE UNIQUE INDEX "AnalysisContactAssociationProjection_jobId_key" ON "AnalysisContactAssociationProjection"("jobId");
CREATE UNIQUE INDEX "ContactAssociationProjection_run_point_revision_key" ON "AnalysisContactAssociationProjection"("analysisRunId", "keyPointId", "reviewRevision");
CREATE INDEX "ContactAssociationProjection_run_point_revision_idx" ON "AnalysisContactAssociationProjection"("analysisRunId", "keyPointId", "reviewRevision");
CREATE INDEX "AnalysisContactAssociationProjection_trackId_idx" ON "AnalysisContactAssociationProjection"("trackId");

-- AddForeignKey
ALTER TABLE "AnalysisContactAssociationJob" ADD CONSTRAINT "AnalysisContactAssociationJob_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnalysisContactAssociationProjection" ADD CONSTRAINT "AnalysisContactAssociationProjection_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AnalysisContactAssociationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AnalysisContactAssociationProjection" ADD CONSTRAINT "AnalysisContactAssociationProjection_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
