CREATE INDEX "CaptureSession_matchId_createdAt_id_idx"
ON "CaptureSession"("matchId", "createdAt", "id");

CREATE INDEX "DvrProgram_captureSessionId_createdAt_id_idx"
ON "DvrProgram"("captureSessionId", "createdAt", "id");
