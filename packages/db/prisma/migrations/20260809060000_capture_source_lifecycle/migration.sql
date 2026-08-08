ALTER TABLE "CaptureSession"
  ADD COLUMN "sourceDurationUs" BIGINT,
  ADD COLUMN "completionExpectedSegments" INTEGER,
  ADD COLUMN "completionRequestedAt" TIMESTAMP(3);

ALTER TABLE "CaptureSession"
  ADD CONSTRAINT "CaptureSession_sourceDurationUs_check"
  CHECK ("sourceDurationUs" IS NULL OR "sourceDurationUs" > 0),
  ADD CONSTRAINT "CaptureSession_completionExpectedSegments_check"
  CHECK ("completionExpectedSegments" IS NULL OR "completionExpectedSegments" >= 0);
