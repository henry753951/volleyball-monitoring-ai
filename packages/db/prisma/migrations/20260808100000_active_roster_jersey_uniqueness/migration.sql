DROP INDEX "MatchRosterEntry_matchId_teamId_jerseyNumber_key";

CREATE UNIQUE INDEX "MatchRosterEntry_active_jersey_key"
ON "MatchRosterEntry"("matchId", "teamId", "jerseyNumber")
WHERE "active" = true;
