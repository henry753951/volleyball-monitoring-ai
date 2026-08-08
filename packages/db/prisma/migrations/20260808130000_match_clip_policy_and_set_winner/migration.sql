ALTER TABLE "Match"
ADD COLUMN "clipPreRollUs" BIGINT NOT NULL DEFAULT 3000000,
ADD COLUMN "clipPostRollUs" BIGINT NOT NULL DEFAULT 3000000;

ALTER TABLE "MatchSet"
ADD COLUMN "winningTeamId" UUID;

ALTER TABLE "MatchSet"
ADD CONSTRAINT "MatchSet_winningTeamId_fkey"
FOREIGN KEY ("winningTeamId") REFERENCES "Team"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "MatchSet_matchId_winningTeamId_idx"
ON "MatchSet"("matchId", "winningTeamId");
