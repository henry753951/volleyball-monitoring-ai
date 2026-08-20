-- Keep coarse physical recording extents while exposing short, independently
-- decodable fMP4 byte ranges to HLS clients. Existing rows remain compatible
-- and continue to play as one physical segment until re-ingested.
ALTER TABLE "DvrSegment"
ADD COLUMN "playbackFragments" JSONB,
ADD COLUMN "playbackSequenceStart" BIGINT;
