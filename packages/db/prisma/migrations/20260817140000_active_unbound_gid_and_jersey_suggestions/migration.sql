-- Jersey VLM is no longer provider-owned ReID evidence. The new tables below
-- hold operator-triggered Central suggestions and their review state.
DROP TABLE IF EXISTS "ReidJerseyVlmEvidence";

ALTER TYPE "MediaAssetKind" ADD VALUE IF NOT EXISTS 'JERSEY_MONTAGE';

-- Several non-co-visible GIDs may legitimately refer to the same roster player.
DROP INDEX IF EXISTS "ReidPersonCluster_canonicalRosterEntryId_key";
CREATE INDEX IF NOT EXISTS "ReidPersonCluster_canonicalRosterEntryId_idx"
  ON "ReidPersonCluster"("canonicalRosterEntryId");

ALTER TABLE "ReidAssociationDecision"
  ADD COLUMN "decisionAction" TEXT NOT NULL DEFAULT 'MATCH_EXISTING_GID',
  ADD COLUMN "newGidGroupKey" TEXT,
  ADD COLUMN "rationale" TEXT NOT NULL DEFAULT 'legacy association decision';

CREATE TABLE "ReidGidRosterBindingRevision" (
  "id" UUID NOT NULL,
  "matchId" UUID NOT NULL,
  "personClusterId" UUID NOT NULL,
  "rosterEntryId" UUID,
  "source" "IdentitySource" NOT NULL,
  "revision" BIGINT NOT NULL,
  "effectiveFromSetNumber" INTEGER NOT NULL,
  "effectiveFromRallyOrdinal" INTEGER NOT NULL,
  "supersedesRevisionId" UUID,
  "correctionId" UUID,
  "createdByUserId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReidGidRosterBindingRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReidGidRosterBindingRevision_matchId_revision_key"
  ON "ReidGidRosterBindingRevision"("matchId", "revision");
CREATE INDEX "ReidGidRosterBindingRevision_cluster_position_revision_idx"
  ON "ReidGidRosterBindingRevision"("personClusterId", "effectiveFromSetNumber", "effectiveFromRallyOrdinal", "revision");
CREATE INDEX "ReidGidRosterBindingRevision_roster_position_idx"
  ON "ReidGidRosterBindingRevision"("rosterEntryId", "effectiveFromSetNumber", "effectiveFromRallyOrdinal");
CREATE INDEX "ReidGidRosterBindingRevision_supersedesRevisionId_idx"
  ON "ReidGidRosterBindingRevision"("supersedesRevisionId");

ALTER TABLE "ReidGidRosterBindingRevision"
  ADD CONSTRAINT "ReidGidRosterBindingRevision_matchId_fkey"
  FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReidGidRosterBindingRevision"
  ADD CONSTRAINT "ReidGidRosterBindingRevision_personClusterId_fkey"
  FOREIGN KEY ("personClusterId") REFERENCES "ReidPersonCluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReidGidRosterBindingRevision"
  ADD CONSTRAINT "ReidGidRosterBindingRevision_rosterEntryId_fkey"
  FOREIGN KEY ("rosterEntryId") REFERENCES "MatchRosterEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReidGidRosterBindingRevision"
  ADD CONSTRAINT "ReidGidRosterBindingRevision_supersedesRevisionId_fkey"
  FOREIGN KEY ("supersedesRevisionId") REFERENCES "ReidGidRosterBindingRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReidGidRosterBindingRevision"
  ADD CONSTRAINT "ReidGidRosterBindingRevision_correctionId_fkey"
  FOREIGN KEY ("correctionId") REFERENCES "ReidIdentityCorrection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReidGidRosterBindingRevision"
  ADD CONSTRAINT "ReidGidRosterBindingRevision_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ReidJerseySuggestionRun" (
  "id" UUID NOT NULL,
  "analysisRunId" UUID NOT NULL,
  "requestedByUserId" UUID NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
  "modelNamespace" TEXT,
  "errorMessage" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leasedUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ReidJerseySuggestionRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReidJerseySuggestionRun_analysisRunId_createdAt_idx"
  ON "ReidJerseySuggestionRun"("analysisRunId", "createdAt");
CREATE INDEX "ReidJerseySuggestionRun_status_availableAt_createdAt_idx"
  ON "ReidJerseySuggestionRun"("status", "availableAt", "createdAt");
ALTER TABLE "ReidJerseySuggestionRun"
  ADD CONSTRAINT "ReidJerseySuggestionRun_analysisRunId_fkey"
  FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReidJerseySuggestionRun"
  ADD CONSTRAINT "ReidJerseySuggestionRun_requestedByUserId_fkey"
  FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ReidJerseySuggestion" (
  "id" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "trackletId" UUID NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
  "selectedFrameIndices" BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[],
  "montageAssetId" UUID,
  "suggestedJerseyNumber" TEXT,
  "suggestedRosterEntryId" UUID,
  "confidence" DOUBLE PRECISION,
  "alternatives" JSONB,
  "rawResponse" JSONB,
  "errorMessage" TEXT,
  "appliedAt" TIMESTAMP(3),
  "appliedByUserId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ReidJerseySuggestion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReidJerseySuggestion_runId_trackletId_key"
  ON "ReidJerseySuggestion"("runId", "trackletId");
CREATE INDEX "ReidJerseySuggestion_status_createdAt_idx"
  ON "ReidJerseySuggestion"("status", "createdAt");
CREATE INDEX "ReidJerseySuggestion_suggestedRosterEntryId_idx"
  ON "ReidJerseySuggestion"("suggestedRosterEntryId");
CREATE INDEX "ReidJerseySuggestion_montageAssetId_idx"
  ON "ReidJerseySuggestion"("montageAssetId");
ALTER TABLE "ReidJerseySuggestion"
  ADD CONSTRAINT "ReidJerseySuggestion_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "ReidJerseySuggestionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReidJerseySuggestion"
  ADD CONSTRAINT "ReidJerseySuggestion_trackletId_fkey"
  FOREIGN KEY ("trackletId") REFERENCES "ReidTracklet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReidJerseySuggestion"
  ADD CONSTRAINT "ReidJerseySuggestion_montageAssetId_fkey"
  FOREIGN KEY ("montageAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReidJerseySuggestion"
  ADD CONSTRAINT "ReidJerseySuggestion_suggestedRosterEntryId_fkey"
  FOREIGN KEY ("suggestedRosterEntryId") REFERENCES "MatchRosterEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReidJerseySuggestion"
  ADD CONSTRAINT "ReidJerseySuggestion_appliedByUserId_fkey"
  FOREIGN KEY ("appliedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
