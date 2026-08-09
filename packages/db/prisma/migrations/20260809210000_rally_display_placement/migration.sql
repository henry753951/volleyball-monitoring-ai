ALTER TABLE "Rally"
ADD COLUMN "displaySetNumber" INTEGER,
ADD COLUMN "displayOrdinal" INTEGER;

UPDATE "Rally" AS rally
SET
  "displaySetNumber" = match_set."setNumber",
  "displayOrdinal" = rally."ordinal"
FROM "MatchSet" AS match_set
WHERE match_set."id" = rally."setId";

ALTER TABLE "Rally"
ALTER COLUMN "displaySetNumber" SET NOT NULL,
ALTER COLUMN "displayOrdinal" SET NOT NULL,
ALTER COLUMN "displaySetNumber" SET DEFAULT 1,
ALTER COLUMN "displayOrdinal" SET DEFAULT 1;

CREATE INDEX "Rally_matchId_displaySetNumber_displayOrdinal_idx"
ON "Rally"("matchId", "displaySetNumber", "displayOrdinal");
