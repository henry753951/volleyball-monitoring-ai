CREATE TABLE "LivePresentationAnchor" (
  "id" UUID NOT NULL,
  "captureSessionId" UUID NOT NULL,
  "captureEpochId" UUID,
  "sequenceIndex" INTEGER NOT NULL,
  "streamInstanceId" TEXT NOT NULL,
  "programDateTime" TIMESTAMP(3) NOT NULL,
  "firstMediaSequence" BIGINT NOT NULL,
  "captureTimeOriginUs" BIGINT,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3),
  "validatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "LivePresentationAnchor_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LivePresentationAnchor_validation_check" CHECK (
    ("captureEpochId" IS NULL AND "captureTimeOriginUs" IS NULL AND "validatedAt" IS NULL)
    OR ("captureEpochId" IS NOT NULL AND "captureTimeOriginUs" IS NOT NULL AND "validatedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "LivePresentationAnchor_captureEpochId_key"
ON "LivePresentationAnchor"("captureEpochId");
CREATE UNIQUE INDEX "LivePresentationAnchor_captureSessionId_sequenceIndex_key"
ON "LivePresentationAnchor"("captureSessionId", "sequenceIndex");
CREATE UNIQUE INDEX "LivePresentationAnchor_captureSessionId_streamInstanceId_key"
ON "LivePresentationAnchor"("captureSessionId", "streamInstanceId");
CREATE INDEX "LivePresentationAnchor_captureSessionId_endedAt_sequenceIndex_idx"
ON "LivePresentationAnchor"("captureSessionId", "endedAt", "sequenceIndex");
CREATE INDEX "LivePresentationAnchor_captureSessionId_programDateTime_idx"
ON "LivePresentationAnchor"("captureSessionId", "programDateTime");

ALTER TABLE "LivePresentationAnchor"
ADD CONSTRAINT "LivePresentationAnchor_captureSessionId_fkey"
FOREIGN KEY ("captureSessionId") REFERENCES "CaptureSession"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LivePresentationAnchor"
ADD CONSTRAINT "LivePresentationAnchor_captureEpochId_fkey"
FOREIGN KEY ("captureEpochId") REFERENCES "CaptureEpoch"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
