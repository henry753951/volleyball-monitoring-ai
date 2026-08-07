ALTER TABLE "AnalysisRun"
ADD COLUMN "identityMappingCompletedAt" TIMESTAMP(3),
ADD COLUMN "identityMappingCompletedByUserId" UUID;

ALTER TABLE "AnalysisRun"
ADD CONSTRAINT "AnalysisRun_identityMappingCompletedByUserId_fkey"
FOREIGN KEY ("identityMappingCompletedByUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
