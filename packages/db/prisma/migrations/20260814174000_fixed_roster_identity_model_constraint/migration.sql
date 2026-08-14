-- A roster slot is a match/team identity anchor, not an embedding model.  The
-- descriptor provenance lives on each ReidFeatureObservation instead.
ALTER TABLE "ReidIdentity"
  DROP CONSTRAINT "ReidIdentity_model_check";
