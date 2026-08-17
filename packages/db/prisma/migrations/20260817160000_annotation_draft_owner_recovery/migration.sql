ALTER TABLE "Rally"
ADD COLUMN "draftOwnerDeviceSessionId" UUID;

UPDATE "Rally" AS rally
SET "draftOwnerDeviceSessionId" = (
  SELECT boundary."deviceSessionId"
  FROM "RallyBoundary" AS boundary
  WHERE boundary."rallyId" = rally.id
    AND boundary.kind = 'START'
  LIMIT 1
)
WHERE rally."activeSubmissionId" IS NULL
  AND rally."annotationStatus" IN ('OPEN', 'READY');

UPDATE "Rally" AS rally
SET "draftOwnerDeviceSessionId" = (
  SELECT point."deviceSessionId"
  FROM "KeyPoint" AS point
  WHERE point."rallyId" = rally.id
    AND point."markerKind" = 'SERVICE'
    AND point."deletedAt" IS NULL
  ORDER BY point."sequenceIndex" ASC, point.id ASC
  LIMIT 1
)
WHERE rally."draftOwnerDeviceSessionId" IS NULL
  AND rally."activeSubmissionId" IS NULL
  AND rally."annotationStatus" IN ('OPEN', 'READY');

ALTER TABLE "Rally"
ADD CONSTRAINT "Rally_draftOwnerDeviceSessionId_fkey"
FOREIGN KEY ("draftOwnerDeviceSessionId") REFERENCES "DeviceSession"(id)
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Rally_draftOwnerDeviceSessionId_annotationStatus_idx"
ON "Rally"("draftOwnerDeviceSessionId", "annotationStatus");
