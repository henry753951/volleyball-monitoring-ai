ALTER TABLE "MatchSet"
ADD COLUMN "winningRallyId" UUID;

CREATE UNIQUE INDEX "MatchSet_winningRallyId_key"
ON "MatchSet"("winningRallyId");

ALTER TABLE "MatchSet"
ADD CONSTRAINT "MatchSet_winningRallyId_fkey"
FOREIGN KEY ("winningRallyId") REFERENCES "Rally"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
