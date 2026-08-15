DROP INDEX "ReidEvidenceSet_analysisRunId_recipeNamespace_key";

ALTER TABLE "ReidEvidenceSet"
ADD COLUMN "resultAssetId" UUID NOT NULL,
ADD COLUMN "resultStatus" TEXT NOT NULL,
ADD COLUMN "unavailableEvidence" JSONB NOT NULL;

CREATE INDEX "ReidEvidenceSet_analysisRunId_recipeNamespace_createdAt_idx"
ON "ReidEvidenceSet"("analysisRunId", "recipeNamespace", "createdAt");

CREATE INDEX "ReidEvidenceSet_resultAssetId_idx"
ON "ReidEvidenceSet"("resultAssetId");

ALTER TABLE "ReidEvidenceSet"
ADD CONSTRAINT "ReidEvidenceSet_resultAssetId_fkey"
FOREIGN KEY ("resultAssetId") REFERENCES "MediaAsset"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
