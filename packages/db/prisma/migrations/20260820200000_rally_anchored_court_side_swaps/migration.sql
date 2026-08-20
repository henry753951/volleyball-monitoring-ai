-- Court-side changes are product events. Anchor them to an immutable rally id so
-- inserting or reordering an earlier rally cannot move the boundary.
CREATE TABLE "CourtSideSwapMarker" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "effectiveRallyId" UUID NOT NULL,
    "leftTeamId" UUID NOT NULL,
    "rightTeamId" UUID NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourtSideSwapMarker_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourtSideSwapMarker_effectiveRallyId_key"
ON "CourtSideSwapMarker"("effectiveRallyId");

CREATE INDEX "CourtSideSwapMarker_matchId_createdAt_id_idx"
ON "CourtSideSwapMarker"("matchId", "createdAt", "id");

ALTER TABLE "CourtSideSwapMarker"
ADD CONSTRAINT "CourtSideSwapMarker_matchId_fkey"
FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CourtSideSwapMarker"
ADD CONSTRAINT "CourtSideSwapMarker_effectiveRallyId_fkey"
FOREIGN KEY ("effectiveRallyId") REFERENCES "Rally"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CourtSideSwapMarker"
ADD CONSTRAINT "CourtSideSwapMarker_leftTeamId_fkey"
FOREIGN KEY ("leftTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CourtSideSwapMarker"
ADD CONSTRAINT "CourtSideSwapMarker_rightTeamId_fkey"
FOREIGN KEY ("rightTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CourtSideSwapMarker"
ADD CONSTRAINT "CourtSideSwapMarker_createdByUserId_fkey"
FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
