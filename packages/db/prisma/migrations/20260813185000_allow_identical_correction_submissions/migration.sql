-- A correction submission is an immutable processing request, not only a
-- content-addressed blob. Operators must be able to submit unchanged geometry
-- again when a newer AI Worker/model needs to reanalyse the same clip.
DROP INDEX IF EXISTS "RallySubmission_rallyId_contentHash_key";

CREATE INDEX IF NOT EXISTS "RallySubmission_rallyId_contentHash_idx"
  ON "RallySubmission"("rallyId", "contentHash");
