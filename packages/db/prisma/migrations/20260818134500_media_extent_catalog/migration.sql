CREATE TYPE "MediaExtentStatus" AS ENUM (
  'WRITING',
  'FINALIZED_LOCAL',
  'CATALOGED',
  'ARCHIVE_PENDING',
  'ARCHIVE_VERIFIED'
);

CREATE TABLE "MediaExtent" (
  "id" UUID NOT NULL,
  "captureSessionId" UUID NOT NULL,
  "dvrProgramId" UUID NOT NULL,
  "dvrSegmentId" UUID,
  "sourceJobId" UUID,
  "source" TEXT NOT NULL,
  "startUs" BIGINT NOT NULL,
  "endUs" BIGINT NOT NULL,
  "localPath" TEXT,
  "bucket" TEXT,
  "objectKey" TEXT,
  "status" "MediaExtentStatus" NOT NULL DEFAULT 'FINALIZED_LOCAL',
  "bytes" BIGINT,
  "finalizedAt" TIMESTAMP(3),
  "catalogedAt" TIMESTAMP(3),
  "archiveVerifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MediaExtent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MediaExtent_time_range_check" CHECK ("endUs" > "startUs"),
  CONSTRAINT "MediaExtent_bytes_check" CHECK ("bytes" IS NULL OR "bytes" >= 0),
  CONSTRAINT "MediaExtent_archive_location_check" CHECK (
    ("bucket" IS NULL AND "objectKey" IS NULL)
    OR ("bucket" IS NOT NULL AND "objectKey" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "MediaExtent_dvrSegmentId_key" ON "MediaExtent"("dvrSegmentId");
CREATE UNIQUE INDEX "MediaExtent_sourceJobId_key" ON "MediaExtent"("sourceJobId");
CREATE INDEX "MediaExtent_dvrProgramId_startUs_endUs_idx"
ON "MediaExtent"("dvrProgramId", "startUs", "endUs");
CREATE INDEX "MediaExtent_captureSessionId_status_createdAt_idx"
ON "MediaExtent"("captureSessionId", "status", "createdAt");
CREATE INDEX "MediaExtent_status_createdAt_id_idx"
ON "MediaExtent"("status", "createdAt", "id");

ALTER TABLE "MediaExtent"
ADD CONSTRAINT "MediaExtent_captureSessionId_fkey"
FOREIGN KEY ("captureSessionId") REFERENCES "CaptureSession"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MediaExtent"
ADD CONSTRAINT "MediaExtent_dvrProgramId_fkey"
FOREIGN KEY ("dvrProgramId") REFERENCES "DvrProgram"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MediaExtent"
ADD CONSTRAINT "MediaExtent_dvrSegmentId_fkey"
FOREIGN KEY ("dvrSegmentId") REFERENCES "DvrSegment"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
