ALTER TABLE "MediaExtent"
ADD COLUMN "sequenceNumber" BIGINT,
ADD COLUMN "discontinuitySequence" INTEGER;

UPDATE "MediaExtent" AS extent
SET
  "sequenceNumber" = segment."sequenceNumber",
  "discontinuitySequence" = segment."discontinuitySequence"
FROM "DvrSegment" AS segment
WHERE extent."dvrSegmentId" = segment."id"
  AND extent."status" = 'ARCHIVE_VERIFIED'
  AND extent."dvrProgramId" = segment."dvrProgramId"
  AND extent."startUs" = segment."captureStartUs"
  AND extent."endUs" = segment."captureEndUs"
  AND extent."sequenceNumber" IS NULL
  AND extent."discontinuitySequence" IS NULL
  AND segment."readyAt" IS NOT NULL
  AND segment."isGap" = FALSE;

ALTER TABLE "MediaExtent"
ADD CONSTRAINT "MediaExtent_continuity_projection_check" CHECK (
  (
    "sequenceNumber" IS NULL
    AND "discontinuitySequence" IS NULL
  )
  OR (
    "sequenceNumber" IS NOT NULL
    AND "sequenceNumber" >= 0
    AND "discontinuitySequence" IS NOT NULL
    AND "discontinuitySequence" >= 0
  )
) NOT VALID;

CREATE INDEX "MediaExtent_dvrProgramId_discontinuitySequence_sequenceNumber_idx"
ON "MediaExtent"("dvrProgramId", "discontinuitySequence", "sequenceNumber");

ALTER TABLE "MediaExtent"
VALIDATE CONSTRAINT "MediaExtent_continuity_projection_check";
