DROP INDEX "LivePresentationAnchor_captureSessionId_streamInstanceId_key";

CREATE UNIQUE INDEX "LivePresentationAnchor_captureSessionId_streamInstanceId_programDateTime_key"
ON "LivePresentationAnchor"("captureSessionId", "streamInstanceId", "programDateTime");
