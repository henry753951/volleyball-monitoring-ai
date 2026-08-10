CREATE TYPE "RosterPosition" AS ENUM (
  'UNSPECIFIED',
  'OH',
  'MB',
  'OPP',
  'S',
  'L',
  'DS'
);

ALTER TABLE "MatchRosterEntry"
ADD COLUMN "position" "RosterPosition" NOT NULL DEFAULT 'UNSPECIFIED';
