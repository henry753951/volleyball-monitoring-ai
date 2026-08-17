ALTER TABLE "ReidBankSnapshot"
ADD COLUMN "derivationVersion" TEXT NOT NULL DEFAULT 'legacy-v1';

DROP INDEX "ReidBankSnapshot_matchId_teamId_revision_asOfSetNumber_asOf_key";

CREATE UNIQUE INDEX "ReidBankSnapshot_match_team_revision_position_derivation_key"
ON "ReidBankSnapshot"(
  "matchId",
  "teamId",
  "revision",
  "asOfSetNumber",
  "asOfRallyOrdinal",
  "derivationVersion"
);
