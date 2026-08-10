ALTER TABLE "Match"
ADD COLUMN "deletionRequestedAt" TIMESTAMP(3);

CREATE INDEX "Match_deletionRequestedAt_idx"
ON "Match"("deletionRequestedAt");
