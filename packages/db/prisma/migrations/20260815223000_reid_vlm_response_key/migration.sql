ALTER TABLE "ReidJerseyVlmEvidence"
ADD COLUMN "rawResponseKey" TEXT NOT NULL;

CREATE UNIQUE INDEX "ReidJerseyVlmEvidence_rawResponseAssetId_rawResponseKey_key"
ON "ReidJerseyVlmEvidence"("rawResponseAssetId", "rawResponseKey");
