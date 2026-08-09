CREATE TYPE "MediaSourceWorkStatus" AS ENUM (
  'REQUESTED',
  'RUNNING',
  'DRAINING',
  'STOP_REQUESTED',
  'COMPLETED',
  'FAILED'
);

ALTER TABLE "CaptureSession"
  ADD COLUMN "sourceOnline" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sourceObservedAt" TIMESTAMP(3);

CREATE TABLE "MediaSourceWork" (
  "id" UUID NOT NULL,
  "captureSessionId" UUID NOT NULL,
  "sourceKind" TEXT NOT NULL,
  "sourceUrl" TEXT,
  "importKey" TEXT,
  "status" "MediaSourceWorkStatus" NOT NULL DEFAULT 'REQUESTED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastHeartbeatAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "segmentBaseAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resumeSegmentIndex" INTEGER NOT NULL DEFAULT 0,
  "resumeCaptureTimeUs" BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MediaSourceWork_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MediaSourceWork_captureSessionId_key" UNIQUE ("captureSessionId"),
  CONSTRAINT "MediaSourceWork_captureSessionId_fkey"
    FOREIGN KEY ("captureSessionId") REFERENCES "CaptureSession"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MediaSourceWork_source_config_check" CHECK (
    ("sourceKind" = 'youtube' AND "sourceUrl" IS NOT NULL AND "importKey" IS NULL)
    OR
    ("sourceKind" = 'local_mp4' AND "sourceUrl" IS NULL AND "importKey" IS NOT NULL)
  ),
  CONSTRAINT "MediaSourceWork_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "MediaSourceWork_resume_check" CHECK (
    "resumeSegmentIndex" >= 0 AND "resumeCaptureTimeUs" >= 0
  ),
  CONSTRAINT "MediaSourceWork_lease_check" CHECK (
    ("leaseOwner" IS NULL AND "leaseExpiresAt" IS NULL)
    OR
    ("leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)
  )
);

CREATE INDEX "MediaSourceWork_status_availableAt_idx"
  ON "MediaSourceWork"("status", "availableAt");
CREATE INDEX "MediaSourceWork_leaseExpiresAt_idx"
  ON "MediaSourceWork"("leaseExpiresAt");
