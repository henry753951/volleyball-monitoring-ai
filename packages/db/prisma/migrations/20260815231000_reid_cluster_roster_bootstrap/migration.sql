ALTER TABLE "ReidPersonCluster"
ADD COLUMN "canonicalRosterEntryId" UUID;

CREATE UNIQUE INDEX "ReidPersonCluster_canonicalRosterEntryId_key"
ON "ReidPersonCluster"("canonicalRosterEntryId");

ALTER TABLE "ReidPersonCluster"
ADD CONSTRAINT "ReidPersonCluster_canonicalRosterEntryId_fkey"
FOREIGN KEY ("canonicalRosterEntryId") REFERENCES "MatchRosterEntry"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
