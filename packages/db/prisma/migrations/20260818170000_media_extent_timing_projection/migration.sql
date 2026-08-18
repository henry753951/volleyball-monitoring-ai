ALTER TABLE "MediaExtent"
ADD COLUMN "captureEpochId" UUID,
ADD COLUMN "sourcePtsStart" BIGINT,
ADD COLUMN "sourcePtsEnd" BIGINT,
ADD COLUMN "firstFrameIndex" BIGINT,
ADD COLUMN "frameCount" BIGINT,
ADD COLUMN "sampleIndexBucket" TEXT,
ADD COLUMN "sampleIndexObjectKey" TEXT,
ADD COLUMN "sampleIndexSha256" TEXT,
ADD COLUMN "sampleIndexBytes" BIGINT,
ADD COLUMN "sampleIndexSchemaVersion" TEXT;

UPDATE "MediaExtent" AS extent
SET
  "captureEpochId" = segment."captureEpochId",
  "sourcePtsStart" = segment."sourcePtsStart",
  "sourcePtsEnd" = segment."sourcePtsEnd",
  "firstFrameIndex" = segment."firstFrameIndex",
  "frameCount" = segment."frameCount",
  "sampleIndexBucket" = sample_index."bucket",
  "sampleIndexObjectKey" = sample_index."objectKey",
  "sampleIndexSha256" = sample_index."sha256",
  "sampleIndexBytes" = sample_index."byteLength",
  "sampleIndexSchemaVersion" = sample_index."internalSchemaVersion"
FROM "DvrSegment" AS segment
JOIN "MediaAsset" AS sample_index
  ON sample_index."id" = segment."sampleIndexAssetId"
JOIN "CaptureEpoch" AS epoch
  ON epoch."id" = segment."captureEpochId"
WHERE extent."dvrSegmentId" = segment."id"
  AND extent."status" = 'ARCHIVE_VERIFIED'
  AND extent."captureSessionId" = epoch."captureSessionId"
  AND extent."dvrProgramId" = segment."dvrProgramId"
  AND extent."startUs" = segment."captureStartUs"
  AND extent."endUs" = segment."captureEndUs"
  AND extent."captureEpochId" IS NULL
  AND extent."sourcePtsStart" IS NULL
  AND extent."sourcePtsEnd" IS NULL
  AND extent."firstFrameIndex" IS NULL
  AND extent."frameCount" IS NULL
  AND extent."sampleIndexBucket" IS NULL
  AND extent."sampleIndexObjectKey" IS NULL
  AND extent."sampleIndexSha256" IS NULL
  AND extent."sampleIndexBytes" IS NULL
  AND extent."sampleIndexSchemaVersion" IS NULL
  AND segment."readyAt" IS NOT NULL
  AND segment."isGap" = FALSE
  AND segment."sourcePtsStart" IS NOT NULL
  AND segment."sourcePtsEnd" IS NOT NULL
  AND segment."firstFrameIndex" IS NOT NULL
  AND segment."frameCount" > 0
  AND sample_index."state" = 'READY'
  AND sample_index."readyAt" IS NOT NULL
  AND sample_index."deletedAt" IS NULL
  AND sample_index."kind" = 'SAMPLE_INDEX'
  AND sample_index."contentType" = 'application/json'
  AND sample_index."internalSchemaVersion" = '1.0.0'
  AND sample_index."sha256" ~ '^[0-9a-f]{64}$'
  AND sample_index."sha256" IS NOT NULL
  AND sample_index."byteLength" IS NOT NULL
  AND sample_index."byteLength" > 0
  AND sample_index."internalSchemaVersion" IS NOT NULL;

ALTER TABLE "MediaExtent"
ADD CONSTRAINT "MediaExtent_timing_projection_check" CHECK (
  (
    "captureEpochId" IS NULL
    AND "sourcePtsStart" IS NULL
    AND "sourcePtsEnd" IS NULL
    AND "firstFrameIndex" IS NULL
    AND "frameCount" IS NULL
    AND "sampleIndexBucket" IS NULL
    AND "sampleIndexObjectKey" IS NULL
    AND "sampleIndexSha256" IS NULL
    AND "sampleIndexBytes" IS NULL
    AND "sampleIndexSchemaVersion" IS NULL
  )
  OR (
    "captureEpochId" IS NOT NULL
    AND "sourcePtsStart" IS NOT NULL
    AND "sourcePtsEnd" IS NOT NULL
    AND "firstFrameIndex" IS NOT NULL
    AND "frameCount" IS NOT NULL
    AND "sampleIndexBucket" IS NOT NULL
    AND "sampleIndexObjectKey" IS NOT NULL
    AND "sampleIndexSha256" IS NOT NULL
    AND "sampleIndexBytes" IS NOT NULL
    AND "sampleIndexSchemaVersion" IS NOT NULL
  )
) NOT VALID,
ADD CONSTRAINT "MediaExtent_source_pts_check" CHECK (
  ("sourcePtsStart" IS NULL AND "sourcePtsEnd" IS NULL)
  OR ("sourcePtsStart" IS NOT NULL AND "sourcePtsEnd" IS NOT NULL AND "sourcePtsEnd" > "sourcePtsStart")
),
ADD CONSTRAINT "MediaExtent_frame_range_check" CHECK (
  ("firstFrameIndex" IS NULL AND "frameCount" IS NULL)
  OR (
    "firstFrameIndex" IS NOT NULL
    AND "firstFrameIndex" >= 0
    AND "frameCount" IS NOT NULL
    AND "frameCount" > 0
  )
),
ADD CONSTRAINT "MediaExtent_sample_index_location_check" CHECK (
  (
    "sampleIndexBucket" IS NULL
    AND "sampleIndexObjectKey" IS NULL
    AND "sampleIndexSha256" IS NULL
    AND "sampleIndexBytes" IS NULL
    AND "sampleIndexSchemaVersion" IS NULL
  )
  OR (
    "sampleIndexBucket" IS NOT NULL
    AND "sampleIndexObjectKey" IS NOT NULL
    AND "sampleIndexSha256" IS NOT NULL
    AND "sampleIndexBytes" IS NOT NULL
    AND "sampleIndexBytes" > 0
    AND "sampleIndexSchemaVersion" IS NOT NULL
  )
);

CREATE INDEX "MediaExtent_captureSessionId_startUs_endUs_idx"
ON "MediaExtent"("captureSessionId", "startUs", "endUs");

CREATE INDEX "MediaExtent_captureEpochId_idx"
ON "MediaExtent"("captureEpochId");

ALTER TABLE "MediaExtent"
ADD CONSTRAINT "MediaExtent_captureEpochId_fkey"
FOREIGN KEY ("captureEpochId") REFERENCES "CaptureEpoch"("id")
ON DELETE RESTRICT ON UPDATE CASCADE
NOT VALID;

ALTER TABLE "MediaExtent"
VALIDATE CONSTRAINT "MediaExtent_timing_projection_check";

ALTER TABLE "MediaExtent"
VALIDATE CONSTRAINT "MediaExtent_captureEpochId_fkey";
