ALTER TABLE "MediaExtent"
ADD COLUMN "mediaSha256" TEXT,
ADD COLUMN "mediaSchemaVersion" TEXT,
ADD COLUMN "initBucket" TEXT,
ADD COLUMN "initObjectKey" TEXT,
ADD COLUMN "initSha256" TEXT,
ADD COLUMN "initBytes" BIGINT,
ADD COLUMN "initSchemaVersion" TEXT;

UPDATE "MediaExtent" AS extent
SET
  "mediaSha256" = media."sha256",
  "mediaSchemaVersion" = media."internalSchemaVersion",
  "initBucket" = init."bucket",
  "initObjectKey" = init."objectKey",
  "initSha256" = init."sha256",
  "initBytes" = init."byteLength",
  "initSchemaVersion" = init."internalSchemaVersion"
FROM "DvrSegment" AS segment
JOIN "MediaAsset" AS init ON init."id" = segment."initAssetId"
JOIN "MediaAsset" AS media ON media."id" = segment."mediaAssetId"
WHERE extent."dvrSegmentId" = segment."id"
  AND extent."status" = 'ARCHIVE_VERIFIED'
  AND extent."dvrProgramId" = segment."dvrProgramId"
  AND extent."startUs" = segment."captureStartUs"
  AND extent."endUs" = segment."captureEndUs"
  AND extent."bucket" = media."bucket"
  AND extent."objectKey" = media."objectKey"
  AND extent."bytes" = media."byteLength"
  AND extent."mediaSha256" IS NULL
  AND extent."mediaSchemaVersion" IS NULL
  AND extent."initBucket" IS NULL
  AND extent."initObjectKey" IS NULL
  AND extent."initSha256" IS NULL
  AND extent."initBytes" IS NULL
  AND extent."initSchemaVersion" IS NULL
  AND segment."readyAt" IS NOT NULL
  AND segment."isGap" = FALSE
  AND init."state" = 'READY'
  AND init."readyAt" IS NOT NULL
  AND init."deletedAt" IS NULL
  AND init."kind" = 'DVR_INIT'
  AND init."contentType" = 'video/mp4'
  AND init."sha256" ~ '^[0-9a-f]{64}$'
  AND init."byteLength" > 0
  AND init."internalSchemaVersion" = '1.0.0'
  AND media."state" = 'READY'
  AND media."readyAt" IS NOT NULL
  AND media."deletedAt" IS NULL
  AND media."kind" = 'DVR_SEGMENT'
  AND media."contentType" = 'video/mp4'
  AND media."sha256" ~ '^[0-9a-f]{64}$'
  AND media."byteLength" > 0
  AND media."internalSchemaVersion" = '1.0.0';

ALTER TABLE "MediaExtent"
ADD CONSTRAINT "MediaExtent_archive_projection_check" CHECK (
  (
    "mediaSha256" IS NULL
    AND "mediaSchemaVersion" IS NULL
    AND "initBucket" IS NULL
    AND "initObjectKey" IS NULL
    AND "initSha256" IS NULL
    AND "initBytes" IS NULL
    AND "initSchemaVersion" IS NULL
  )
  OR (
    "mediaSha256" ~ '^[0-9a-f]{64}$'
    AND "mediaSchemaVersion" IS NOT NULL
    AND "initBucket" IS NOT NULL
    AND "initObjectKey" IS NOT NULL
    AND "initSha256" ~ '^[0-9a-f]{64}$'
    AND "initBytes" IS NOT NULL
    AND "initBytes" > 0
    AND "initSchemaVersion" IS NOT NULL
  )
) NOT VALID;

ALTER TABLE "MediaExtent"
VALIDATE CONSTRAINT "MediaExtent_archive_projection_check";
