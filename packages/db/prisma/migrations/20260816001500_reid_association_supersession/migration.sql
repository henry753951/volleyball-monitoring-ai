ALTER TABLE "ReidAssociationRun"
ADD COLUMN "supersededAt" TIMESTAMP(3),
ADD COLUMN "supersededByRunId" UUID;

ALTER TABLE "ReidAssociationRun"
ADD CONSTRAINT "ReidAssociationRun_supersededByRunId_fkey"
FOREIGN KEY ("supersededByRunId") REFERENCES "ReidAssociationRun"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ReidAssociationRun_evidenceSetId_supersededAt_createdAt_idx"
ON "ReidAssociationRun"("evidenceSetId", "supersededAt", "createdAt");

CREATE INDEX "ReidAssociationRun_supersededByRunId_idx"
ON "ReidAssociationRun"("supersededByRunId");
