-- Hard cut from unbounded sequential GIDs to six match/team roster slots.
-- Manual roster assignments remain; only derived ReID state is rebuilt.
UPDATE "TrackIdentityAssignment"
SET "reidIdentityId" = NULL, "reidBindingId" = NULL, "identityRevision" = NULL
WHERE "reidIdentityId" IS NOT NULL OR "reidBindingId" IS NOT NULL;

DELETE FROM "ReidCorrectionEvent";
DELETE FROM "ReidPlayerBinding";
DELETE FROM "ReidFeatureObservation";
DELETE FROM "ReidIdentity";

ALTER TABLE "ReidIdentity" ADD COLUMN "slotIndex" INTEGER NOT NULL;
ALTER TABLE "ReidIdentity" ADD CONSTRAINT "ReidIdentity_slotIndex_check"
  CHECK ("slotIndex" BETWEEN 1 AND 6);
DROP INDEX "ReidIdentity_matchId_modelNamespace_label_key";
CREATE UNIQUE INDEX "ReidIdentity_matchId_teamId_slotIndex_key"
  ON "ReidIdentity"("matchId", "teamId", "slotIndex");

ALTER TABLE "ReidFeatureObservation"
  ADD COLUMN "canonicalTrackId" INTEGER NOT NULL,
  ADD COLUMN "isCanonicalTrack" BOOLEAN NOT NULL,
  ADD COLUMN "aliasTrackIds" INTEGER[] NOT NULL,
  ADD COLUMN "medianCourtX" DOUBLE PRECISION,
  ADD COLUMN "medianCourtY" DOUBLE PRECISION,
  ADD COLUMN "descriptorRecipe" JSONB NOT NULL,
  ADD COLUMN "dinoDescriptor" BYTEA,
  ADD COLUMN "osnetDescriptor" BYTEA,
  ADD COLUMN "kprDescriptor" BYTEA,
  ADD COLUMN "kprPromptDescriptor" BYTEA,
  ADD COLUMN "promptCoverage" DOUBLE PRECISION NOT NULL,
  ADD COLUMN "selectedModalities" TEXT[] NOT NULL,
  ADD COLUMN "selectedKernel" TEXT NOT NULL,
  ADD COLUMN "selectedRegularization" DOUBLE PRECISION NOT NULL;
