CREATE TYPE "RallyBoundaryKind" AS ENUM ('START', 'END');

ALTER TYPE "SubmissionScoreResolution" ADD VALUE IF NOT EXISTS 'PENDING' BEFORE 'RESOLVED';

CREATE TABLE "RallyBoundary" (
    "id" UUID NOT NULL,
    "rallyId" UUID NOT NULL,
    "kind" "RallyBoundaryKind" NOT NULL,
    "captureEpochId" UUID NOT NULL,
    "sourcePts" BIGINT NOT NULL,
    "captureTimeUs" BIGINT NOT NULL,
    "captureFrameIndex" BIGINT NOT NULL,
    "timingPrecision" "TimingPrecision" NOT NULL,
    "originalPlaybackCursor" JSONB NOT NULL,
    "snapDistanceUs" BIGINT,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "deviceSessionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RallyBoundary_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RallySubmissionBoundary" (
    "id" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "sourceDraftBoundaryId" UUID NOT NULL,
    "kind" "RallyBoundaryKind" NOT NULL,
    "captureEpochId" UUID NOT NULL,
    "sourcePts" BIGINT NOT NULL,
    "captureTimeUs" BIGINT NOT NULL,
    "captureFrameIndex" BIGINT NOT NULL,
    "timingPrecision" "TimingPrecision" NOT NULL,
    CONSTRAINT "RallySubmissionBoundary_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RallyBoundary_rallyId_kind_key" ON "RallyBoundary"("rallyId", "kind");
CREATE INDEX "RallyBoundary_rallyId_captureTimeUs_idx" ON "RallyBoundary"("rallyId", "captureTimeUs");
CREATE UNIQUE INDEX "RallySubmissionBoundary_submissionId_kind_key" ON "RallySubmissionBoundary"("submissionId", "kind");
CREATE UNIQUE INDEX "RallySubmissionBoundary_submissionId_sourceDraftBoundaryId_key" ON "RallySubmissionBoundary"("submissionId", "sourceDraftBoundaryId");
CREATE INDEX "RallySubmissionBoundary_captureEpochId_idx" ON "RallySubmissionBoundary"("captureEpochId");

ALTER TABLE "RallyBoundary" ADD CONSTRAINT "RallyBoundary_rallyId_fkey"
FOREIGN KEY ("rallyId") REFERENCES "Rally"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RallyBoundary" ADD CONSTRAINT "RallyBoundary_captureEpochId_fkey"
FOREIGN KEY ("captureEpochId") REFERENCES "CaptureEpoch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RallySubmissionBoundary" ADD CONSTRAINT "RallySubmissionBoundary_submissionId_fkey"
FOREIGN KEY ("submissionId") REFERENCES "RallySubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RallySubmissionBoundary" ADD CONSTRAINT "RallySubmissionBoundary_sourceDraftBoundaryId_fkey"
FOREIGN KEY ("sourceDraftBoundaryId") REFERENCES "RallyBoundary"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RallySubmissionBoundary" ADD CONSTRAINT "RallySubmissionBoundary_captureEpochId_fkey"
FOREIGN KEY ("captureEpochId") REFERENCES "CaptureEpoch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Historical submissions stay on the v2 key-point representation. New boundary
-- rows identify v3 drafts unambiguously; read paths retain the legacy fallback.
