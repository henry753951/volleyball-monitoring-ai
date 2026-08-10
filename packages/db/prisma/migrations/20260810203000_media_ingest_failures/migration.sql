CREATE TABLE "MediaIngestFailure" (
  "sourceJobId" UUID NOT NULL,
  "captureSessionId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MediaIngestFailure_pkey" PRIMARY KEY ("sourceJobId")
);

CREATE INDEX "MediaIngestFailure_captureSessionId_idx"
ON "MediaIngestFailure"("captureSessionId");

ALTER TABLE "MediaIngestFailure"
ADD CONSTRAINT "MediaIngestFailure_captureSessionId_fkey"
FOREIGN KEY ("captureSessionId") REFERENCES "CaptureSession"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
