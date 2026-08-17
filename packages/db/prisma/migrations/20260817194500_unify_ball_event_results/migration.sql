DROP TYPE IF EXISTS "BallEventResult_v2";
CREATE TYPE "BallEventResult_v2" AS ENUM ('SUCCESS', 'FAILURE');

DROP INDEX IF EXISTS "BallEventDraft_kind_result_idx";
DROP INDEX IF EXISTS "RallySubmissionBallEvent_submissionId_kind_result_idx";
ALTER TABLE "BallEventDraft" DROP CONSTRAINT IF EXISTS "BallEventDraft_result_matches_kind";
ALTER TABLE "RallySubmissionBallEvent"
DROP CONSTRAINT IF EXISTS "RallySubmissionBallEvent_result_matches_kind";

ALTER TABLE "BallEventDraft"
ALTER COLUMN "result" TYPE "BallEventResult_v2"
USING (
  CASE
    WHEN "result" IS NULL THEN NULL
    WHEN "result"::text IN ('POINT_SCORED', 'SUCCESS') THEN 'SUCCESS'::"BallEventResult_v2"
    ELSE 'FAILURE'::"BallEventResult_v2"
  END
);

ALTER TABLE "RallySubmissionBallEvent"
ALTER COLUMN "result" TYPE "BallEventResult_v2"
USING (
  CASE
    WHEN "result" IS NULL THEN NULL
    WHEN "result"::text IN ('POINT_SCORED', 'SUCCESS') THEN 'SUCCESS'::"BallEventResult_v2"
    ELSE 'FAILURE'::"BallEventResult_v2"
  END
);

DROP TYPE "BallEventResult";
ALTER TYPE "BallEventResult_v2" RENAME TO "BallEventResult";

ALTER TABLE "BallEventDraft"
ADD CONSTRAINT "BallEventDraft_result_matches_kind"
CHECK (
  ("kind" = 'CONTACT' AND "result" IS NULL)
  OR
  ("kind" <> 'CONTACT' AND ("result" IS NULL OR "result" IN ('SUCCESS', 'FAILURE')))
);

ALTER TABLE "RallySubmissionBallEvent"
ADD CONSTRAINT "RallySubmissionBallEvent_result_matches_kind"
CHECK (
  ("kind" = 'CONTACT' AND "result" IS NULL)
  OR
  ("kind" <> 'CONTACT' AND ("result" IS NULL OR "result" IN ('SUCCESS', 'FAILURE')))
);

CREATE INDEX "BallEventDraft_kind_result_idx"
ON "BallEventDraft"("kind", "result");

CREATE INDEX "RallySubmissionBallEvent_submissionId_kind_result_idx"
ON "RallySubmissionBallEvent"("submissionId", "kind", "result");
