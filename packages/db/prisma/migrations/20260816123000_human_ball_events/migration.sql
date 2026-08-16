CREATE TYPE "BallEventKind" AS ENUM ('SERVE', 'RECEIVE', 'CONTACT', 'SPIKE');
CREATE TYPE "BallEventResult" AS ENUM ('POINT_SCORED', 'SUCCESS', 'ERROR', 'POINT_LOST', 'FAILURE');
CREATE TYPE "BallEventSemanticSource" AS ENUM ('HUMAN', 'SYSTEM_DEFAULT', 'AUTOMATIC', 'CORRECTION_COPY');

CREATE TABLE "BallEventDraft" (
    "id" UUID NOT NULL,
    "keyPointId" UUID NOT NULL,
    "kind" "BallEventKind" NOT NULL,
    "result" "BallEventResult",
    "semanticSource" "BallEventSemanticSource" NOT NULL DEFAULT 'SYSTEM_DEFAULT',
    "kindLocked" BOOLEAN NOT NULL DEFAULT false,
    "resultLocked" BOOLEAN NOT NULL DEFAULT false,
    "actorRosterEntryId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BallEventDraft_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BallEventDraft_result_matches_kind" CHECK (
      ("kind" = 'SERVE' AND ("result" IS NULL OR "result" IN ('POINT_SCORED', 'SUCCESS', 'ERROR'))) OR
      ("kind" = 'RECEIVE' AND ("result" IS NULL OR "result" IN ('SUCCESS', 'ERROR', 'POINT_LOST'))) OR
      ("kind" = 'SPIKE' AND ("result" IS NULL OR "result" IN ('SUCCESS', 'FAILURE'))) OR
      ("kind" = 'CONTACT' AND "result" IS NULL)
    )
);

CREATE TABLE "RallySubmissionBallEvent" (
    "id" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "submissionKeyPointId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" "BallEventKind" NOT NULL,
    "result" "BallEventResult",
    "semanticSource" "BallEventSemanticSource" NOT NULL,
    "actorRosterEntryId" UUID,
    CONSTRAINT "RallySubmissionBallEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RallySubmissionBallEvent_result_matches_kind" CHECK (
      ("kind" = 'SERVE' AND "result" IN ('POINT_SCORED', 'SUCCESS', 'ERROR')) OR
      ("kind" = 'RECEIVE' AND "result" IN ('SUCCESS', 'ERROR', 'POINT_LOST')) OR
      ("kind" = 'SPIKE' AND "result" IN ('SUCCESS', 'FAILURE')) OR
      ("kind" = 'CONTACT' AND "result" IS NULL)
    )
);

CREATE UNIQUE INDEX "BallEventDraft_keyPointId_key" ON "BallEventDraft"("keyPointId");
CREATE INDEX "BallEventDraft_kind_result_idx" ON "BallEventDraft"("kind", "result");
CREATE INDEX "BallEventDraft_actorRosterEntryId_idx" ON "BallEventDraft"("actorRosterEntryId");
CREATE UNIQUE INDEX "RallySubmissionBallEvent_submissionKeyPointId_key" ON "RallySubmissionBallEvent"("submissionKeyPointId");
CREATE UNIQUE INDEX "RallySubmissionBallEvent_submissionId_ordinal_key" ON "RallySubmissionBallEvent"("submissionId", "ordinal");
CREATE INDEX "RallySubmissionBallEvent_submissionId_kind_result_idx" ON "RallySubmissionBallEvent"("submissionId", "kind", "result");
CREATE INDEX "RallySubmissionBallEvent_actorRosterEntryId_idx" ON "RallySubmissionBallEvent"("actorRosterEntryId");

ALTER TABLE "BallEventDraft" ADD CONSTRAINT "BallEventDraft_keyPointId_fkey" FOREIGN KEY ("keyPointId") REFERENCES "KeyPoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BallEventDraft" ADD CONSTRAINT "BallEventDraft_actorRosterEntryId_fkey" FOREIGN KEY ("actorRosterEntryId") REFERENCES "MatchRosterEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RallySubmissionBallEvent" ADD CONSTRAINT "RallySubmissionBallEvent_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "RallySubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RallySubmissionBallEvent" ADD CONSTRAINT "RallySubmissionBallEvent_submissionKeyPointId_fkey" FOREIGN KEY ("submissionKeyPointId") REFERENCES "RallySubmissionKeyPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RallySubmissionBallEvent" ADD CONSTRAINT "RallySubmissionBallEvent_actorRosterEntryId_fkey" FOREIGN KEY ("actorRosterEntryId") REFERENCES "MatchRosterEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RallySubmission" ADD COLUMN "analysisSourceRunId" UUID;
CREATE INDEX "RallySubmission_analysisSourceRunId_idx" ON "RallySubmission"("analysisSourceRunId");
ALTER TABLE "RallySubmission" ADD CONSTRAINT "RallySubmission_analysisSourceRunId_fkey" FOREIGN KEY ("analysisSourceRunId") REFERENCES "AnalysisRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
