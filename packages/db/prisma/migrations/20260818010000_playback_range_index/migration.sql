CREATE INDEX "DvrSegment_dvrProgramId_captureEndUs_captureStartUs_idx"
ON "DvrSegment"("dvrProgramId", "captureEndUs", "captureStartUs");

CREATE INDEX "PlaybackWindow_expiresAt_id_idx"
ON "PlaybackWindow"("expiresAt", "id");
