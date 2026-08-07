CREATE TYPE "PlaybackWindowMode" AS ENUM ('LIVE', 'ARCHIVE');
ALTER TABLE "MediaAsset" ADD COLUMN "internalSchemaVersion" TEXT;
ALTER TABLE "DvrSegment" ADD CONSTRAINT "DvrSegment_capture_range_check" CHECK ("captureEndUs" >= "captureStartUs") , ADD CONSTRAINT "DvrSegment_nonnegative_check" CHECK ("durationUs" >= 0 AND "frameCount" >= 0);
CREATE TABLE "PlaybackWindow" (
  "id" UUID NOT NULL, "captureSessionId" UUID NOT NULL, "dvrProgramId" UUID NOT NULL, "createdByUserId" UUID NOT NULL,
  "mode" "PlaybackWindowMode" NOT NULL, "mappingVersion" INTEGER NOT NULL DEFAULT 1, "timelineVersion" BIGINT NOT NULL,
  "captureStartUs" BIGINT NOT NULL, "captureEndUs" BIGINT NOT NULL, "presentationOriginCaptureUs" BIGINT NOT NULL,
  "targetPlayerMediaTimeUs" BIGINT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlaybackWindow_pkey" PRIMARY KEY ("id"), CONSTRAINT "PlaybackWindow_capture_range_check" CHECK ("captureEndUs" > "captureStartUs"),
  CONSTRAINT "PlaybackWindow_origin_check" CHECK ("presentationOriginCaptureUs" >= "captureStartUs" AND "presentationOriginCaptureUs" <= "captureEndUs"),
  CONSTRAINT "PlaybackWindow_target_within_mapping_check" CHECK ("targetPlayerMediaTimeUs" <= "captureEndUs" - "presentationOriginCaptureUs"),
  CONSTRAINT "PlaybackWindow_target_check" CHECK ("targetPlayerMediaTimeUs" >= 0), CONSTRAINT "PlaybackWindow_mapping_check" CHECK ("mappingVersion" > 0)
);
CREATE TABLE "PlaybackWindowSegment" (
  "id" UUID NOT NULL, "playbackWindowId" UUID NOT NULL, "dvrSegmentId" UUID NOT NULL, "sequenceIndex" INTEGER NOT NULL,
  CONSTRAINT "PlaybackWindowSegment_pkey" PRIMARY KEY ("id"), CONSTRAINT "PlaybackWindowSegment_sequence_check" CHECK ("sequenceIndex" >= 0)
);
CREATE UNIQUE INDEX "PlaybackWindowSegment_window_sequence_key" ON "PlaybackWindowSegment"("playbackWindowId", "sequenceIndex");
CREATE UNIQUE INDEX "PlaybackWindowSegment_window_segment_key" ON "PlaybackWindowSegment"("playbackWindowId", "dvrSegmentId");
CREATE INDEX "PlaybackWindow_capture_expiry_idx" ON "PlaybackWindow"("captureSessionId", "expiresAt");
CREATE INDEX "PlaybackWindow_program_range_idx" ON "PlaybackWindow"("dvrProgramId", "captureStartUs", "captureEndUs");
ALTER TABLE "PlaybackWindow" ADD CONSTRAINT "PlaybackWindow_captureSessionId_fkey" FOREIGN KEY ("captureSessionId") REFERENCES "CaptureSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlaybackWindow" ADD CONSTRAINT "PlaybackWindow_dvrProgramId_fkey" FOREIGN KEY ("dvrProgramId") REFERENCES "DvrProgram"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlaybackWindow" ADD CONSTRAINT "PlaybackWindow_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlaybackWindowSegment" ADD CONSTRAINT "PlaybackWindowSegment_playbackWindowId_fkey" FOREIGN KEY ("playbackWindowId") REFERENCES "PlaybackWindow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlaybackWindowSegment" ADD CONSTRAINT "PlaybackWindowSegment_dvrSegmentId_fkey" FOREIGN KEY ("dvrSegmentId") REFERENCES "DvrSegment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
