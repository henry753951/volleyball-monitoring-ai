ALTER TABLE "Rally"
ADD COLUMN "sideAssignmentReversed" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "RallySubmission"
ADD COLUMN "sideAssignmentReversed" BOOLEAN NOT NULL DEFAULT false;
