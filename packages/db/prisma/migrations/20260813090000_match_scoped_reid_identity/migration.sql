CREATE TYPE "ReidCorrectionKind" AS ENUM ('FROM_HERE', 'CLIP_ONLY', 'SPLIT_IDENTITY', 'MERGE_IDENTITY');

ALTER TABLE "Match"
ADD COLUMN "identityRevision" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "TrackIdentityAssignment"
ADD COLUMN "reidIdentityId" UUID,
ADD COLUMN "reidBindingId" UUID,
ADD COLUMN "identityRevision" BIGINT;

CREATE TABLE "ReidIdentity" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "matchId" UUID NOT NULL,
  "teamId" UUID NOT NULL,
  "modelNamespace" TEXT NOT NULL,
  "modelName" TEXT NOT NULL,
  "modelCheckpointSha256" TEXT NOT NULL,
  "modelPreprocessVersion" TEXT NOT NULL,
  "modelDimension" INTEGER NOT NULL,
  "modelDistance" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "createdRevision" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReidIdentity_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReidIdentity_model_check" CHECK (
    "modelDimension" = 512
    AND "modelDistance" = 'cosine'
    AND "modelCheckpointSha256" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "ReidIdentity_revision_check" CHECK ("createdRevision" >= 0)
);

CREATE TABLE "ReidFeatureObservation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "analysisRunId" UUID NOT NULL,
  "trackId" INTEGER NOT NULL,
  "matchId" UUID NOT NULL,
  "teamId" UUID,
  "reidIdentityId" UUID,
  "modelNamespace" TEXT NOT NULL,
  "modelName" TEXT NOT NULL,
  "modelCheckpointSha256" TEXT NOT NULL,
  "modelPreprocessVersion" TEXT NOT NULL,
  "modelDimension" INTEGER NOT NULL,
  "modelDistance" TEXT NOT NULL,
  "courtSide" "TrackCourtSide" NOT NULL,
  "provisionalGid" TEXT NOT NULL,
  "firstFrame" BIGINT NOT NULL,
  "lastFrame" BIGINT NOT NULL,
  "sampleCount" INTEGER NOT NULL,
  "meanQuality" DOUBLE PRECISION NOT NULL,
  "prototype" BYTEA NOT NULL,
  "cannotLinkTrackIds" INTEGER[] NOT NULL,
  "setNumber" INTEGER NOT NULL,
  "rallyOrdinal" INTEGER NOT NULL,
  "matchConfidence" DOUBLE PRECISION,
  "identityRevision" BIGINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReidFeatureObservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReidFeatureObservation_model_check" CHECK (
    "modelDimension" = 512
    AND "modelDistance" = 'cosine'
    AND "modelCheckpointSha256" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "ReidFeatureObservation_prototype_check" CHECK (octet_length("prototype") = 2048),
  CONSTRAINT "ReidFeatureObservation_frame_check" CHECK ("firstFrame" >= 0 AND "lastFrame" >= "firstFrame"),
  CONSTRAINT "ReidFeatureObservation_sample_check" CHECK ("sampleCount" > 0),
  CONSTRAINT "ReidFeatureObservation_quality_check" CHECK ("meanQuality" >= 0 AND "meanQuality" <= 1),
  CONSTRAINT "ReidFeatureObservation_confidence_check" CHECK ("matchConfidence" IS NULL OR ("matchConfidence" >= -1 AND "matchConfidence" <= 1)),
  CONSTRAINT "ReidFeatureObservation_order_check" CHECK ("setNumber" > 0 AND "rallyOrdinal" > 0),
  CONSTRAINT "ReidFeatureObservation_revision_check" CHECK ("identityRevision" >= 0)
);

CREATE TABLE "ReidPlayerBinding" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "reidIdentityId" UUID NOT NULL,
  "rosterEntryId" UUID,
  "sourceObservationId" UUID,
  "effectiveFromSetNumber" INTEGER NOT NULL,
  "effectiveFromRallyOrdinal" INTEGER NOT NULL,
  "source" "IdentitySource" NOT NULL DEFAULT 'MANUAL',
  "identityRevision" BIGINT NOT NULL,
  "assignedByUserId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReidPlayerBinding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReidPlayerBinding_order_check" CHECK ("effectiveFromSetNumber" > 0 AND "effectiveFromRallyOrdinal" > 0),
  CONSTRAINT "ReidPlayerBinding_revision_check" CHECK ("identityRevision" > 0)
);

CREATE TABLE "ReidCorrectionEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "matchId" UUID NOT NULL,
  "teamId" UUID NOT NULL,
  "analysisRunId" UUID,
  "trackId" INTEGER,
  "sourceIdentityId" UUID,
  "targetIdentityId" UUID,
  "rosterEntryId" UUID,
  "kind" "ReidCorrectionKind" NOT NULL,
  "identityRevision" BIGINT NOT NULL,
  "createdByUserId" UUID,
  "details" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReidCorrectionEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReidCorrectionEvent_track_check" CHECK ("trackId" IS NULL OR "trackId" >= 0),
  CONSTRAINT "ReidCorrectionEvent_revision_check" CHECK ("identityRevision" > 0)
);

CREATE UNIQUE INDEX "ReidIdentity_matchId_teamId_modelNamespace_label_key"
ON "ReidIdentity"("matchId", "teamId", "modelNamespace", "label");
CREATE INDEX "ReidIdentity_matchId_teamId_modelNamespace_createdAt_idx"
ON "ReidIdentity"("matchId", "teamId", "modelNamespace", "createdAt");

CREATE UNIQUE INDEX "ReidFeatureObservation_analysisRunId_trackId_key"
ON "ReidFeatureObservation"("analysisRunId", "trackId");
CREATE INDEX "ReidFeatureObservation_matchId_teamId_modelNamespace_setNumber_rallyOrdinal_idx"
ON "ReidFeatureObservation"("matchId", "teamId", "modelNamespace", "setNumber", "rallyOrdinal");
CREATE INDEX "ReidFeatureObservation_reidIdentityId_setNumber_rallyOrdinal_idx"
ON "ReidFeatureObservation"("reidIdentityId", "setNumber", "rallyOrdinal");

CREATE INDEX "ReidPlayerBinding_reidIdentityId_effectiveFromSetNumber_effectiveFromRallyOrdinal_identityRevision_idx"
ON "ReidPlayerBinding"("reidIdentityId", "effectiveFromSetNumber", "effectiveFromRallyOrdinal", "identityRevision");
CREATE INDEX "ReidPlayerBinding_rosterEntryId_idx" ON "ReidPlayerBinding"("rosterEntryId");

CREATE UNIQUE INDEX "ReidCorrectionEvent_matchId_identityRevision_key"
ON "ReidCorrectionEvent"("matchId", "identityRevision");
CREATE INDEX "ReidCorrectionEvent_analysisRunId_trackId_idx"
ON "ReidCorrectionEvent"("analysisRunId", "trackId");
CREATE INDEX "ReidCorrectionEvent_sourceIdentityId_idx" ON "ReidCorrectionEvent"("sourceIdentityId");
CREATE INDEX "ReidCorrectionEvent_targetIdentityId_idx" ON "ReidCorrectionEvent"("targetIdentityId");

CREATE INDEX "TrackIdentityAssignment_reidIdentityId_idx" ON "TrackIdentityAssignment"("reidIdentityId");
CREATE INDEX "TrackIdentityAssignment_reidBindingId_idx" ON "TrackIdentityAssignment"("reidBindingId");

ALTER TABLE "ReidIdentity"
ADD CONSTRAINT "ReidIdentity_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "ReidIdentity_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReidFeatureObservation"
ADD CONSTRAINT "ReidFeatureObservation_analysisRunId_trackId_fkey" FOREIGN KEY ("analysisRunId", "trackId") REFERENCES "AnalysisTrack"("analysisRunId", "trackId") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "ReidFeatureObservation_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "ReidFeatureObservation_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "ReidFeatureObservation_reidIdentityId_fkey" FOREIGN KEY ("reidIdentityId") REFERENCES "ReidIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ReidPlayerBinding"
ADD CONSTRAINT "ReidPlayerBinding_reidIdentityId_fkey" FOREIGN KEY ("reidIdentityId") REFERENCES "ReidIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "ReidPlayerBinding_rosterEntryId_fkey" FOREIGN KEY ("rosterEntryId") REFERENCES "MatchRosterEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "ReidPlayerBinding_sourceObservationId_fkey" FOREIGN KEY ("sourceObservationId") REFERENCES "ReidFeatureObservation"("id") ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "ReidPlayerBinding_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ReidCorrectionEvent"
ADD CONSTRAINT "ReidCorrectionEvent_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "ReidCorrectionEvent_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
ADD CONSTRAINT "ReidCorrectionEvent_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "ReidCorrectionEvent_sourceIdentityId_fkey" FOREIGN KEY ("sourceIdentityId") REFERENCES "ReidIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "ReidCorrectionEvent_targetIdentityId_fkey" FOREIGN KEY ("targetIdentityId") REFERENCES "ReidIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "ReidCorrectionEvent_rosterEntryId_fkey" FOREIGN KEY ("rosterEntryId") REFERENCES "MatchRosterEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "ReidCorrectionEvent_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TrackIdentityAssignment"
ADD CONSTRAINT "TrackIdentityAssignment_reidIdentityId_fkey" FOREIGN KEY ("reidIdentityId") REFERENCES "ReidIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "TrackIdentityAssignment_reidBindingId_fkey" FOREIGN KEY ("reidBindingId") REFERENCES "ReidPlayerBinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;
