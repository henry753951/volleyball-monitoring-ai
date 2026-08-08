-- A stable HLS/MSE playback window advances by dropping an already-buffered
-- prefix and appending new DVR segments. The presentation origin stays fixed
-- so browser media time remains continuous while captureStartUs moves forward.
ALTER TABLE "PlaybackWindow"
  DROP CONSTRAINT "PlaybackWindow_origin_check";

ALTER TABLE "PlaybackWindow"
  ADD CONSTRAINT "PlaybackWindow_origin_check"
  CHECK ("presentationOriginCaptureUs" <= "captureEndUs");
