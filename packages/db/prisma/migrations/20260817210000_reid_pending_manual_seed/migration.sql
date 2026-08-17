ALTER TABLE "TrackIdentityAssignment"
ADD COLUMN "pendingCorrectionMode" TEXT;

ALTER TABLE "ReidAssociationRerunRequest"
ADD COLUMN "requestedIdentityRevision" BIGINT;

CREATE UNIQUE INDEX "ReidAssociationRerunRequest_analysisRunId_requestedIdentityRevision_key"
ON "ReidAssociationRerunRequest"("analysisRunId", "requestedIdentityRevision");
