-- AddEnumValue
ALTER TYPE "ProviderWorkKind" ADD VALUE 'IDENTITY_PREVIEW_GENERATION';

-- AlterTable
ALTER TABLE "ReidIdentityPreview" ADD COLUMN "providerJobId" UUID;

-- AlterTable
ALTER TABLE "AnalysisEvidenceBundle" ADD COLUMN "cropSourceManifestAssetId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "ReidIdentityPreview_providerJobId_key" ON "ReidIdentityPreview"("providerJobId");

-- CreateIndex
CREATE INDEX "AnalysisEvidenceBundle_cropSourceManifestAssetId_idx" ON "AnalysisEvidenceBundle"("cropSourceManifestAssetId");

-- AddForeignKey
ALTER TABLE "ReidIdentityPreview" ADD CONSTRAINT "ReidIdentityPreview_providerJobId_fkey" FOREIGN KEY ("providerJobId") REFERENCES "ProviderJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisEvidenceBundle" ADD CONSTRAINT "AnalysisEvidenceBundle_cropSourceManifestAssetId_fkey" FOREIGN KEY ("cropSourceManifestAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
