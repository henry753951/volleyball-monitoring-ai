ALTER TABLE "CoachHighlightExportJob"
  ADD COLUMN "sourceFingerprint" TEXT;

CREATE INDEX "CoachHighlightExportJob_requestedByUserId_sourceFingerprint_createdAt_idx"
  ON "CoachHighlightExportJob"("requestedByUserId", "sourceFingerprint", "createdAt");
