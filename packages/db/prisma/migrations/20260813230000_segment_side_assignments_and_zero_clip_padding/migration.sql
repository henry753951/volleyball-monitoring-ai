-- Court-side changes are effective from a rally ordinal. They are no longer
-- represented as media-timeline markers.
DROP TABLE IF EXISTS "CourtSideSwapMarker";

ALTER TABLE "Match"
ALTER COLUMN "clipPreRollUs" SET DEFAULT 0,
ALTER COLUMN "clipPostRollUs" SET DEFAULT 0;

-- Only migrate matches that still carry the former untouched defaults.
-- Explicitly customized clip policies remain unchanged.
UPDATE "Match"
SET "clipPreRollUs" = 0,
    "clipPostRollUs" = 0
WHERE "clipPreRollUs" = 3000000
  AND "clipPostRollUs" = 3000000;
