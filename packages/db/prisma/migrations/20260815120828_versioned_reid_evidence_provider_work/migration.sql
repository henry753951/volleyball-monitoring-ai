-- CreateEnum
CREATE TYPE "ProviderWorkKind" AS ENUM ('ANALYSIS', 'REID_FEATURE_EXTRACTION', 'REID_ASSOCIATION', 'PERSON_POSE_EVIDENCE_REBUILD');

-- CreateEnum
CREATE TYPE "ProviderArtifactDirection" AS ENUM ('INPUT', 'OUTPUT');

-- CreateEnum
CREATE TYPE "ReidEvidenceState" AS ENUM ('UNVERIFIED', 'CONFIRMED', 'REJECTED', 'QUARANTINED');

-- CreateEnum
CREATE TYPE "ReidEvidenceRole" AS ENUM ('POSITIVE', 'NEGATIVE');

-- CreateEnum
CREATE TYPE "ReidAssociationState" AS ENUM ('RESOLVED', 'UNRESOLVED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "ReidCorrectionDisplayScope" AS ENUM ('CURRENT_CLIP', 'FROM_HERE', 'WHOLE_MATCH');

-- CreateEnum
CREATE TYPE "ReidFutureEvidenceAction" AS ENUM ('NONE', 'CONFIRM_TARGET', 'REJECT_SOURCE', 'QUARANTINE_SOURCE');

-- ExtendEnum
ALTER TYPE "MediaAssetKind" ADD VALUE 'PROVIDER_ARTIFACT';
ALTER TYPE "MediaAssetKind" ADD VALUE 'PERSON_POSE_EVIDENCE';
ALTER TYPE "MediaAssetKind" ADD VALUE 'REID_EVIDENCE';
ALTER TYPE "MediaAssetKind" ADD VALUE 'IDENTITY_PREVIEW';

-- CreateTable
CREATE TABLE "ProviderJob" (
    "id" UUID NOT NULL,
    "workKind" "ProviderWorkKind" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "idempotencyKey" TEXT NOT NULL,
    "requestSchemaVersion" TEXT NOT NULL,
    "resultSchemaVersion" TEXT NOT NULL,
    "requestPayload" JSONB NOT NULL,
    "requestPayloadHash" TEXT NOT NULL,
    "callbackTokenHash" TEXT NOT NULL,
    "callbackTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "providerInstanceId" UUID,
    "analysisRunId" UUID,
    "parentProviderJobId" UUID,
    "deliveryId" UUID,
    "providerExecutionId" TEXT,
    "cancelRequestedAt" TIMESTAMP(3),
    "cancelAcknowledgedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leasedUntil" TIMESTAMP(3),
    "progress" DOUBLE PRECISION,
    "stage" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastCallbackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderJobArtifact" (
    "id" UUID NOT NULL,
    "providerJobId" UUID NOT NULL,
    "mediaAssetId" UUID NOT NULL,
    "direction" "ProviderArtifactDirection" NOT NULL,
    "artifactKind" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "schemaVersion" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byteLength" BIGINT NOT NULL,
    "contentType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderJobArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCallbackReceipt" (
    "id" UUID NOT NULL,
    "providerJobId" UUID NOT NULL,
    "callbackId" TEXT NOT NULL,
    "kind" "CallbackKind" NOT NULL,
    "requestContentType" TEXT NOT NULL,
    "requestMetadata" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderCallbackReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisEvidenceBundle" (
    "id" UUID NOT NULL,
    "analysisRunId" UUID NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "manifestAssetId" UUID NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "canonicalFrameCount" BIGINT NOT NULL,
    "status" "ArtifactState" NOT NULL DEFAULT 'UPLOADING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),

    CONSTRAINT "AnalysisEvidenceBundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonPoseEvidenceManifest" (
    "id" UUID NOT NULL,
    "analysisRunId" UUID NOT NULL,
    "analysisEvidenceBundleId" UUID NOT NULL,
    "recipeNamespace" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "manifestAssetId" UUID NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "canonicalFrameCount" BIGINT NOT NULL,
    "playerObservationCount" BIGINT NOT NULL,
    "poseObservationCount" BIGINT NOT NULL,
    "missingObservationCount" BIGINT NOT NULL,
    "status" "ArtifactState" NOT NULL DEFAULT 'UPLOADING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),

    CONSTRAINT "PersonPoseEvidenceManifest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonPoseEvidenceChunk" (
    "poseManifestId" UUID NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "startFrameIndex" BIGINT NOT NULL,
    "endFrameIndex" BIGINT NOT NULL,
    "playerObservationCount" BIGINT NOT NULL,
    "poseObservationCount" BIGINT NOT NULL,
    "missingObservationCount" BIGINT NOT NULL,
    "assetId" UUID NOT NULL,
    "sha256" TEXT NOT NULL,
    "byteLength" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonPoseEvidenceChunk_pkey" PRIMARY KEY ("poseManifestId","chunkIndex")
);

-- CreateTable
CREATE TABLE "ReidEvidenceSet" (
    "id" UUID NOT NULL,
    "analysisRunId" UUID NOT NULL,
    "analysisEvidenceBundleId" UUID NOT NULL,
    "providerJobId" UUID NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "recipeNamespace" TEXT NOT NULL,
    "descriptorBundleAssetId" UUID NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "status" "ArtifactState" NOT NULL DEFAULT 'UPLOADING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),

    CONSTRAINT "ReidEvidenceSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReidTracklet" (
    "id" UUID NOT NULL,
    "evidenceSetId" UUID NOT NULL,
    "canonicalTrackId" INTEGER NOT NULL,
    "trackIdAliases" INTEGER[],
    "courtSide" "TrackCourtSide" NOT NULL,
    "firstFrameIndex" BIGINT NOT NULL,
    "lastFrameIndex" BIGINT NOT NULL,
    "cannotLinkTrackletIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReidTracklet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReidFeatureVector" (
    "id" UUID NOT NULL,
    "trackletId" UUID NOT NULL,
    "modality" TEXT NOT NULL,
    "modelNamespace" TEXT NOT NULL,
    "dimension" INTEGER NOT NULL,
    "normalization" TEXT NOT NULL,
    "distance" TEXT NOT NULL,
    "byteOffset" BIGINT NOT NULL,
    "byteLength" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sourceFrameIndices" BIGINT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReidFeatureVector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReidJerseyVlmEvidence" (
    "id" UUID NOT NULL,
    "trackletId" UUID NOT NULL,
    "modelNamespace" TEXT NOT NULL,
    "rawResponseAssetId" UUID NOT NULL,
    "rawResponseSha256" TEXT NOT NULL,
    "candidateNumbers" INTEGER[],
    "selectedFrameIndices" BIGINT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReidJerseyVlmEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReidPersonCluster" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "teamId" UUID,
    "label" TEXT,
    "createdRevision" BIGINT NOT NULL,
    "supersededRevision" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReidPersonCluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReidEvidenceMembership" (
    "id" UUID NOT NULL,
    "personClusterId" UUID NOT NULL,
    "trackletId" UUID NOT NULL,
    "rosterEntryId" UUID,
    "evidenceState" "ReidEvidenceState" NOT NULL,
    "evidenceRole" "ReidEvidenceRole" NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "sourceRevision" BIGINT NOT NULL,
    "supersedesMembershipId" UUID,
    "correctionId" UUID,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReidEvidenceMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReidCannotLink" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "leftTrackletId" UUID NOT NULL,
    "rightTrackletId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceRevision" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReidCannotLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReidBankSnapshot" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "revision" BIGINT NOT NULL,
    "asOfSetNumber" INTEGER NOT NULL,
    "asOfRallyOrdinal" INTEGER NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "manifestAssetId" UUID NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReidBankSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReidAssociationRun" (
    "id" UUID NOT NULL,
    "evidenceSetId" UUID NOT NULL,
    "bankSnapshotId" UUID NOT NULL,
    "providerJobId" UUID NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "shadowOnly" BOOLEAN NOT NULL DEFAULT true,
    "resultAssetId" UUID,
    "contentSha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ReidAssociationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReidAssociationDecision" (
    "id" UUID NOT NULL,
    "associationRunId" UUID NOT NULL,
    "trackletId" UUID NOT NULL,
    "groupKey" TEXT NOT NULL,
    "associationState" "ReidAssociationState" NOT NULL,
    "selectedPersonClusterId" UUID,
    "selectedRosterEntryId" UUID,
    "confidence" DOUBLE PRECISION,
    "candidates" JSONB NOT NULL,
    "unresolvedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReidAssociationDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReidIdentityCorrection" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "teamId" UUID,
    "analysisRunId" UUID NOT NULL,
    "trackletId" UUID NOT NULL,
    "sourcePersonClusterId" UUID,
    "targetPersonClusterId" UUID,
    "rosterEntryId" UUID,
    "displayScope" "ReidCorrectionDisplayScope" NOT NULL,
    "futureEvidenceAction" "ReidFutureEvidenceAction" NOT NULL,
    "revision" BIGINT NOT NULL,
    "reason" TEXT,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReidIdentityCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReidAssignmentRevision" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "analysisRunId" UUID NOT NULL,
    "trackletId" UUID NOT NULL,
    "personClusterId" UUID,
    "rosterEntryId" UUID,
    "correctionId" UUID,
    "source" "IdentitySource" NOT NULL,
    "sourcePriority" INTEGER NOT NULL,
    "revision" BIGINT NOT NULL,
    "effectiveFromSetNumber" INTEGER NOT NULL,
    "effectiveFromRallyOrdinal" INTEGER NOT NULL,
    "supersedesRevisionId" UUID,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReidAssignmentRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReidActiveProjection" (
    "analysisRunId" UUID NOT NULL,
    "trackletId" UUID NOT NULL,
    "assignmentRevisionId" UUID NOT NULL,
    "sourcePriority" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReidActiveProjection_pkey" PRIMARY KEY ("analysisRunId","trackletId")
);

-- CreateTable
CREATE TABLE "ReidIdentityPreview" (
    "id" UUID NOT NULL,
    "trackletId" UUID NOT NULL,
    "recipeNamespace" TEXT NOT NULL,
    "mediaAssetId" UUID NOT NULL,
    "startFrameIndex" BIGINT NOT NULL,
    "endFrameIndex" BIGINT NOT NULL,
    "frameCount" INTEGER NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "status" "ArtifactState" NOT NULL DEFAULT 'UPLOADING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),

    CONSTRAINT "ReidIdentityPreview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderJob_idempotencyKey_key" ON "ProviderJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ProviderJob_workKind_status_availableAt_idx" ON "ProviderJob"("workKind", "status", "availableAt");

-- CreateIndex
CREATE INDEX "ProviderJob_providerInstanceId_status_idx" ON "ProviderJob"("providerInstanceId", "status");

-- CreateIndex
CREATE INDEX "ProviderJob_analysisRunId_workKind_createdAt_idx" ON "ProviderJob"("analysisRunId", "workKind", "createdAt");

-- CreateIndex
CREATE INDEX "ProviderJob_parentProviderJobId_idx" ON "ProviderJob"("parentProviderJobId");

-- CreateIndex
CREATE INDEX "ProviderJobArtifact_mediaAssetId_idx" ON "ProviderJobArtifact"("mediaAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderJobArtifact_providerJobId_direction_ordinal_key" ON "ProviderJobArtifact"("providerJobId", "direction", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCallbackReceipt_callbackId_key" ON "ProviderCallbackReceipt"("callbackId");

-- CreateIndex
CREATE INDEX "ProviderCallbackReceipt_providerJobId_receivedAt_idx" ON "ProviderCallbackReceipt"("providerJobId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisEvidenceBundle_analysisRunId_key" ON "AnalysisEvidenceBundle"("analysisRunId");

-- CreateIndex
CREATE INDEX "AnalysisEvidenceBundle_status_createdAt_idx" ON "AnalysisEvidenceBundle"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AnalysisEvidenceBundle_manifestAssetId_idx" ON "AnalysisEvidenceBundle"("manifestAssetId");

-- CreateIndex
CREATE INDEX "PersonPoseEvidenceManifest_analysisEvidenceBundleId_idx" ON "PersonPoseEvidenceManifest"("analysisEvidenceBundleId");

-- CreateIndex
CREATE INDEX "PersonPoseEvidenceManifest_status_createdAt_idx" ON "PersonPoseEvidenceManifest"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PersonPoseEvidenceManifest_analysisRunId_recipeNamespace_key" ON "PersonPoseEvidenceManifest"("analysisRunId", "recipeNamespace");

-- CreateIndex
CREATE INDEX "PersonPoseEvidenceChunk_poseManifestId_startFrameIndex_idx" ON "PersonPoseEvidenceChunk"("poseManifestId", "startFrameIndex");

-- CreateIndex
CREATE INDEX "PersonPoseEvidenceChunk_assetId_idx" ON "PersonPoseEvidenceChunk"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "ReidEvidenceSet_providerJobId_key" ON "ReidEvidenceSet"("providerJobId");

-- CreateIndex
CREATE INDEX "ReidEvidenceSet_analysisEvidenceBundleId_idx" ON "ReidEvidenceSet"("analysisEvidenceBundleId");

-- CreateIndex
CREATE INDEX "ReidEvidenceSet_status_createdAt_idx" ON "ReidEvidenceSet"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReidEvidenceSet_analysisRunId_recipeNamespace_key" ON "ReidEvidenceSet"("analysisRunId", "recipeNamespace");

-- CreateIndex
CREATE INDEX "ReidTracklet_evidenceSetId_firstFrameIndex_lastFrameIndex_idx" ON "ReidTracklet"("evidenceSetId", "firstFrameIndex", "lastFrameIndex");

-- CreateIndex
CREATE UNIQUE INDEX "ReidTracklet_evidenceSetId_canonicalTrackId_key" ON "ReidTracklet"("evidenceSetId", "canonicalTrackId");

-- CreateIndex
CREATE INDEX "ReidFeatureVector_modelNamespace_modality_dimension_idx" ON "ReidFeatureVector"("modelNamespace", "modality", "dimension");

-- CreateIndex
CREATE UNIQUE INDEX "ReidFeatureVector_trackletId_modality_modelNamespace_key" ON "ReidFeatureVector"("trackletId", "modality", "modelNamespace");

-- CreateIndex
CREATE UNIQUE INDEX "ReidJerseyVlmEvidence_trackletId_key" ON "ReidJerseyVlmEvidence"("trackletId");

-- CreateIndex
CREATE INDEX "ReidJerseyVlmEvidence_modelNamespace_createdAt_idx" ON "ReidJerseyVlmEvidence"("modelNamespace", "createdAt");

-- CreateIndex
CREATE INDEX "ReidJerseyVlmEvidence_rawResponseAssetId_idx" ON "ReidJerseyVlmEvidence"("rawResponseAssetId");

-- CreateIndex
CREATE INDEX "ReidPersonCluster_matchId_teamId_createdAt_idx" ON "ReidPersonCluster"("matchId", "teamId", "createdAt");

-- CreateIndex
CREATE INDEX "ReidPersonCluster_matchId_supersededRevision_idx" ON "ReidPersonCluster"("matchId", "supersededRevision");

-- CreateIndex
CREATE INDEX "ReidEvidenceMembership_trackletId_sourceRevision_idx" ON "ReidEvidenceMembership"("trackletId", "sourceRevision");

-- CreateIndex
CREATE INDEX "ReidEvidenceMembership_personClusterId_evidenceState_eviden_idx" ON "ReidEvidenceMembership"("personClusterId", "evidenceState", "evidenceRole", "sourceRevision");

-- CreateIndex
CREATE INDEX "ReidEvidenceMembership_supersedesMembershipId_idx" ON "ReidEvidenceMembership"("supersedesMembershipId");

-- CreateIndex
CREATE UNIQUE INDEX "ReidEvidenceMembership_personClusterId_trackletId_sourceRev_key" ON "ReidEvidenceMembership"("personClusterId", "trackletId", "sourceRevision");

-- CreateIndex
CREATE INDEX "ReidCannotLink_rightTrackletId_idx" ON "ReidCannotLink"("rightTrackletId");

-- CreateIndex
CREATE UNIQUE INDEX "ReidCannotLink_matchId_leftTrackletId_rightTrackletId_sourc_key" ON "ReidCannotLink"("matchId", "leftTrackletId", "rightTrackletId", "sourceRevision");

-- CreateIndex
CREATE INDEX "ReidBankSnapshot_matchId_teamId_asOfSetNumber_asOfRallyOrdi_idx" ON "ReidBankSnapshot"("matchId", "teamId", "asOfSetNumber", "asOfRallyOrdinal");

-- CreateIndex
CREATE UNIQUE INDEX "ReidBankSnapshot_matchId_teamId_revision_asOfSetNumber_asOf_key" ON "ReidBankSnapshot"("matchId", "teamId", "revision", "asOfSetNumber", "asOfRallyOrdinal");

-- CreateIndex
CREATE UNIQUE INDEX "ReidAssociationRun_providerJobId_key" ON "ReidAssociationRun"("providerJobId");

-- CreateIndex
CREATE INDEX "ReidAssociationRun_evidenceSetId_createdAt_idx" ON "ReidAssociationRun"("evidenceSetId", "createdAt");

-- CreateIndex
CREATE INDEX "ReidAssociationRun_bankSnapshotId_idx" ON "ReidAssociationRun"("bankSnapshotId");

-- CreateIndex
CREATE INDEX "ReidAssociationRun_status_shadowOnly_createdAt_idx" ON "ReidAssociationRun"("status", "shadowOnly", "createdAt");

-- CreateIndex
CREATE INDEX "ReidAssociationDecision_trackletId_createdAt_idx" ON "ReidAssociationDecision"("trackletId", "createdAt");

-- CreateIndex
CREATE INDEX "ReidAssociationDecision_selectedPersonClusterId_idx" ON "ReidAssociationDecision"("selectedPersonClusterId");

-- CreateIndex
CREATE UNIQUE INDEX "ReidAssociationDecision_associationRunId_trackletId_key" ON "ReidAssociationDecision"("associationRunId", "trackletId");

-- CreateIndex
CREATE INDEX "ReidIdentityCorrection_analysisRunId_trackletId_idx" ON "ReidIdentityCorrection"("analysisRunId", "trackletId");

-- CreateIndex
CREATE INDEX "ReidIdentityCorrection_targetPersonClusterId_idx" ON "ReidIdentityCorrection"("targetPersonClusterId");

-- CreateIndex
CREATE UNIQUE INDEX "ReidIdentityCorrection_matchId_revision_key" ON "ReidIdentityCorrection"("matchId", "revision");

-- CreateIndex
CREATE INDEX "ReidAssignmentRevision_analysisRunId_trackletId_revision_idx" ON "ReidAssignmentRevision"("analysisRunId", "trackletId", "revision");

-- CreateIndex
CREATE INDEX "ReidAssignmentRevision_supersedesRevisionId_idx" ON "ReidAssignmentRevision"("supersedesRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "ReidAssignmentRevision_matchId_revision_key" ON "ReidAssignmentRevision"("matchId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "ReidActiveProjection_trackletId_key" ON "ReidActiveProjection"("trackletId");

-- CreateIndex
CREATE UNIQUE INDEX "ReidActiveProjection_assignmentRevisionId_key" ON "ReidActiveProjection"("assignmentRevisionId");

-- CreateIndex
CREATE INDEX "ReidActiveProjection_analysisRunId_sourcePriority_idx" ON "ReidActiveProjection"("analysisRunId", "sourcePriority");

-- CreateIndex
CREATE INDEX "ReidIdentityPreview_status_createdAt_idx" ON "ReidIdentityPreview"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ReidIdentityPreview_mediaAssetId_idx" ON "ReidIdentityPreview"("mediaAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "ReidIdentityPreview_trackletId_recipeNamespace_key" ON "ReidIdentityPreview"("trackletId", "recipeNamespace");

-- CreateIndex
CREATE INDEX "MatchRosterEntry_matchId_teamId_jerseyNumber_idx" ON "MatchRosterEntry"("matchId", "teamId", "jerseyNumber");

-- CreateIndex
CREATE INDEX "ReidIdentity_matchId_teamId_createdAt_idx" ON "ReidIdentity"("matchId", "teamId", "createdAt");

-- RenameForeignKey
ALTER TABLE "AnalysisDataManifest" RENAME CONSTRAINT "OverlayManifest_analysisRunId_fkey" TO "AnalysisDataManifest_analysisRunId_fkey";

-- RenameForeignKey
ALTER TABLE "AnalysisFrameChunk" RENAME CONSTRAINT "OverlayChunk_analysisRunId_fkey" TO "AnalysisFrameChunk_analysisRunId_fkey";

-- RenameForeignKey
ALTER TABLE "AnalysisFrameChunk" RENAME CONSTRAINT "OverlayChunk_assetId_fkey" TO "AnalysisFrameChunk_assetId_fkey";

-- RenameForeignKey
ALTER TABLE "AnalysisRun" RENAME CONSTRAINT "AnalysisRun_rawAnalysisAssetId_fkey" TO "AnalysisRun_rawAnalysisDataAssetId_fkey";

-- AddForeignKey
ALTER TABLE "ProviderJob" ADD CONSTRAINT "ProviderJob_providerInstanceId_fkey" FOREIGN KEY ("providerInstanceId") REFERENCES "AiProviderInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderJob" ADD CONSTRAINT "ProviderJob_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderJob" ADD CONSTRAINT "ProviderJob_parentProviderJobId_fkey" FOREIGN KEY ("parentProviderJobId") REFERENCES "ProviderJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderJobArtifact" ADD CONSTRAINT "ProviderJobArtifact_providerJobId_fkey" FOREIGN KEY ("providerJobId") REFERENCES "ProviderJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderJobArtifact" ADD CONSTRAINT "ProviderJobArtifact_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCallbackReceipt" ADD CONSTRAINT "ProviderCallbackReceipt_providerJobId_fkey" FOREIGN KEY ("providerJobId") REFERENCES "ProviderJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisEvidenceBundle" ADD CONSTRAINT "AnalysisEvidenceBundle_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisEvidenceBundle" ADD CONSTRAINT "AnalysisEvidenceBundle_manifestAssetId_fkey" FOREIGN KEY ("manifestAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonPoseEvidenceManifest" ADD CONSTRAINT "PersonPoseEvidenceManifest_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonPoseEvidenceManifest" ADD CONSTRAINT "PersonPoseEvidenceManifest_analysisEvidenceBundleId_fkey" FOREIGN KEY ("analysisEvidenceBundleId") REFERENCES "AnalysisEvidenceBundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonPoseEvidenceManifest" ADD CONSTRAINT "PersonPoseEvidenceManifest_manifestAssetId_fkey" FOREIGN KEY ("manifestAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonPoseEvidenceChunk" ADD CONSTRAINT "PersonPoseEvidenceChunk_poseManifestId_fkey" FOREIGN KEY ("poseManifestId") REFERENCES "PersonPoseEvidenceManifest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonPoseEvidenceChunk" ADD CONSTRAINT "PersonPoseEvidenceChunk_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidEvidenceSet" ADD CONSTRAINT "ReidEvidenceSet_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidEvidenceSet" ADD CONSTRAINT "ReidEvidenceSet_analysisEvidenceBundleId_fkey" FOREIGN KEY ("analysisEvidenceBundleId") REFERENCES "AnalysisEvidenceBundle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidEvidenceSet" ADD CONSTRAINT "ReidEvidenceSet_providerJobId_fkey" FOREIGN KEY ("providerJobId") REFERENCES "ProviderJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidEvidenceSet" ADD CONSTRAINT "ReidEvidenceSet_descriptorBundleAssetId_fkey" FOREIGN KEY ("descriptorBundleAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidTracklet" ADD CONSTRAINT "ReidTracklet_evidenceSetId_fkey" FOREIGN KEY ("evidenceSetId") REFERENCES "ReidEvidenceSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidFeatureVector" ADD CONSTRAINT "ReidFeatureVector_trackletId_fkey" FOREIGN KEY ("trackletId") REFERENCES "ReidTracklet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidJerseyVlmEvidence" ADD CONSTRAINT "ReidJerseyVlmEvidence_trackletId_fkey" FOREIGN KEY ("trackletId") REFERENCES "ReidTracklet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidJerseyVlmEvidence" ADD CONSTRAINT "ReidJerseyVlmEvidence_rawResponseAssetId_fkey" FOREIGN KEY ("rawResponseAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidPersonCluster" ADD CONSTRAINT "ReidPersonCluster_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidPersonCluster" ADD CONSTRAINT "ReidPersonCluster_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidEvidenceMembership" ADD CONSTRAINT "ReidEvidenceMembership_personClusterId_fkey" FOREIGN KEY ("personClusterId") REFERENCES "ReidPersonCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidEvidenceMembership" ADD CONSTRAINT "ReidEvidenceMembership_trackletId_fkey" FOREIGN KEY ("trackletId") REFERENCES "ReidTracklet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidEvidenceMembership" ADD CONSTRAINT "ReidEvidenceMembership_rosterEntryId_fkey" FOREIGN KEY ("rosterEntryId") REFERENCES "MatchRosterEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidEvidenceMembership" ADD CONSTRAINT "ReidEvidenceMembership_supersedesMembershipId_fkey" FOREIGN KEY ("supersedesMembershipId") REFERENCES "ReidEvidenceMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidEvidenceMembership" ADD CONSTRAINT "ReidEvidenceMembership_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "ReidIdentityCorrection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidEvidenceMembership" ADD CONSTRAINT "ReidEvidenceMembership_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidCannotLink" ADD CONSTRAINT "ReidCannotLink_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidCannotLink" ADD CONSTRAINT "ReidCannotLink_leftTrackletId_fkey" FOREIGN KEY ("leftTrackletId") REFERENCES "ReidTracklet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidCannotLink" ADD CONSTRAINT "ReidCannotLink_rightTrackletId_fkey" FOREIGN KEY ("rightTrackletId") REFERENCES "ReidTracklet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidBankSnapshot" ADD CONSTRAINT "ReidBankSnapshot_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidBankSnapshot" ADD CONSTRAINT "ReidBankSnapshot_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidBankSnapshot" ADD CONSTRAINT "ReidBankSnapshot_manifestAssetId_fkey" FOREIGN KEY ("manifestAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidAssociationRun" ADD CONSTRAINT "ReidAssociationRun_evidenceSetId_fkey" FOREIGN KEY ("evidenceSetId") REFERENCES "ReidEvidenceSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidAssociationRun" ADD CONSTRAINT "ReidAssociationRun_bankSnapshotId_fkey" FOREIGN KEY ("bankSnapshotId") REFERENCES "ReidBankSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidAssociationRun" ADD CONSTRAINT "ReidAssociationRun_providerJobId_fkey" FOREIGN KEY ("providerJobId") REFERENCES "ProviderJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidAssociationRun" ADD CONSTRAINT "ReidAssociationRun_resultAssetId_fkey" FOREIGN KEY ("resultAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidAssociationDecision" ADD CONSTRAINT "ReidAssociationDecision_associationRunId_fkey" FOREIGN KEY ("associationRunId") REFERENCES "ReidAssociationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidAssociationDecision" ADD CONSTRAINT "ReidAssociationDecision_trackletId_fkey" FOREIGN KEY ("trackletId") REFERENCES "ReidTracklet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidAssociationDecision" ADD CONSTRAINT "ReidAssociationDecision_selectedPersonClusterId_fkey" FOREIGN KEY ("selectedPersonClusterId") REFERENCES "ReidPersonCluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidAssociationDecision" ADD CONSTRAINT "ReidAssociationDecision_selectedRosterEntryId_fkey" FOREIGN KEY ("selectedRosterEntryId") REFERENCES "MatchRosterEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidIdentityCorrection" ADD CONSTRAINT "ReidIdentityCorrection_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidIdentityCorrection" ADD CONSTRAINT "ReidIdentityCorrection_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidIdentityCorrection" ADD CONSTRAINT "ReidIdentityCorrection_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidIdentityCorrection" ADD CONSTRAINT "ReidIdentityCorrection_trackletId_fkey" FOREIGN KEY ("trackletId") REFERENCES "ReidTracklet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidIdentityCorrection" ADD CONSTRAINT "ReidIdentityCorrection_sourcePersonClusterId_fkey" FOREIGN KEY ("sourcePersonClusterId") REFERENCES "ReidPersonCluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidIdentityCorrection" ADD CONSTRAINT "ReidIdentityCorrection_targetPersonClusterId_fkey" FOREIGN KEY ("targetPersonClusterId") REFERENCES "ReidPersonCluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidIdentityCorrection" ADD CONSTRAINT "ReidIdentityCorrection_rosterEntryId_fkey" FOREIGN KEY ("rosterEntryId") REFERENCES "MatchRosterEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidIdentityCorrection" ADD CONSTRAINT "ReidIdentityCorrection_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidAssignmentRevision" ADD CONSTRAINT "ReidAssignmentRevision_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidAssignmentRevision" ADD CONSTRAINT "ReidAssignmentRevision_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidAssignmentRevision" ADD CONSTRAINT "ReidAssignmentRevision_trackletId_fkey" FOREIGN KEY ("trackletId") REFERENCES "ReidTracklet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidAssignmentRevision" ADD CONSTRAINT "ReidAssignmentRevision_personClusterId_fkey" FOREIGN KEY ("personClusterId") REFERENCES "ReidPersonCluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidAssignmentRevision" ADD CONSTRAINT "ReidAssignmentRevision_rosterEntryId_fkey" FOREIGN KEY ("rosterEntryId") REFERENCES "MatchRosterEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidAssignmentRevision" ADD CONSTRAINT "ReidAssignmentRevision_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "ReidIdentityCorrection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidAssignmentRevision" ADD CONSTRAINT "ReidAssignmentRevision_supersedesRevisionId_fkey" FOREIGN KEY ("supersedesRevisionId") REFERENCES "ReidAssignmentRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidAssignmentRevision" ADD CONSTRAINT "ReidAssignmentRevision_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidActiveProjection" ADD CONSTRAINT "ReidActiveProjection_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidActiveProjection" ADD CONSTRAINT "ReidActiveProjection_trackletId_fkey" FOREIGN KEY ("trackletId") REFERENCES "ReidTracklet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidActiveProjection" ADD CONSTRAINT "ReidActiveProjection_assignmentRevisionId_fkey" FOREIGN KEY ("assignmentRevisionId") REFERENCES "ReidAssignmentRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidIdentityPreview" ADD CONSTRAINT "ReidIdentityPreview_trackletId_fkey" FOREIGN KEY ("trackletId") REFERENCES "ReidTracklet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReidIdentityPreview" ADD CONSTRAINT "ReidIdentityPreview_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "OverlayChunk_analysisRunId_startFrameIndex_idx" RENAME TO "AnalysisFrameChunk_analysisRunId_startFrameIndex_idx";

-- RenameIndex
ALTER INDEX "OverlayChunk_assetId_idx" RENAME TO "AnalysisFrameChunk_assetId_idx";

-- RenameIndex
ALTER INDEX "AnnotationCommandReceipt_rally_sequence_idx" RENAME TO "AnnotationCommandReceipt_rallyId_serverSequence_idx";

-- RenameIndex
ALTER INDEX "AnnotationCommandReceipt_room_sequence_idx" RENAME TO "AnnotationCommandReceipt_roomId_serverSequence_idx";

-- RenameIndex
ALTER INDEX "PlaybackWindow_capture_expiry_idx" RENAME TO "PlaybackWindow_captureSessionId_expiresAt_idx";

-- RenameIndex
ALTER INDEX "PlaybackWindow_program_range_idx" RENAME TO "PlaybackWindow_dvrProgramId_captureStartUs_captureEndUs_idx";

-- RenameIndex
ALTER INDEX "PlaybackWindowSegment_window_segment_key" RENAME TO "PlaybackWindowSegment_playbackWindowId_dvrSegmentId_key";

-- RenameIndex
ALTER INDEX "PlaybackWindowSegment_window_sequence_key" RENAME TO "PlaybackWindowSegment_playbackWindowId_sequenceIndex_key";

-- RenameIndex
ALTER INDEX "ReidFeatureObservation_matchId_teamId_modelNamespace_setNumber_" RENAME TO "ReidFeatureObservation_matchId_teamId_modelNamespace_setNum_idx";

-- RenameIndex
ALTER INDEX "ReidFeatureObservation_reidIdentityId_setNumber_rallyOrdinal_id" RENAME TO "ReidFeatureObservation_reidIdentityId_setNumber_rallyOrdina_idx";

-- RenameIndex
ALTER INDEX "ReidPlayerBinding_reidIdentityId_effectiveFromSetNumber_effecti" RENAME TO "ReidPlayerBinding_reidIdentityId_effectiveFromSetNumber_eff_idx";
