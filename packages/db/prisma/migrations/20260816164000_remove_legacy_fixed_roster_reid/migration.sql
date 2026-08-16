-- Destructive hard cut approved by the product owner. The fixed six-slot ReID
-- model and its compatibility columns are not migrated into versioned evidence.

ALTER TABLE "TrackIdentityAssignment"
  DROP CONSTRAINT IF EXISTS "TrackIdentityAssignment_reidIdentityId_fkey",
  DROP CONSTRAINT IF EXISTS "TrackIdentityAssignment_reidBindingId_fkey";

DROP INDEX IF EXISTS "TrackIdentityAssignment_reidIdentityId_idx";
DROP INDEX IF EXISTS "TrackIdentityAssignment_reidBindingId_idx";

ALTER TABLE "TrackIdentityAssignment"
  DROP COLUMN IF EXISTS "reidIdentityId",
  DROP COLUMN IF EXISTS "reidBindingId";

DROP TABLE IF EXISTS "ReidCorrectionEvent";
DROP TABLE IF EXISTS "ReidPlayerBinding";
DROP TABLE IF EXISTS "ReidFeatureObservation";
DROP TABLE IF EXISTS "ReidIdentity";

DROP TYPE IF EXISTS "ReidCorrectionKind";
