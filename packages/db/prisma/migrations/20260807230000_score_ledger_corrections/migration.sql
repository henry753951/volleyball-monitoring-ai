-- A single ordered ledger serializes both initial point awards and later
-- immutable submission corrections. Existing awards retain their identifiers
-- so the backfill is deterministic and idempotency/audit references stay stable.
CREATE TYPE "ScoreLedgerEntryKind" AS ENUM ('POINT_AWARD', 'CORRECTION');

CREATE TABLE "ScoreLedgerEntry" (
    "id" UUID NOT NULL,
    "kind" "ScoreLedgerEntryKind" NOT NULL,
    "setId" UUID NOT NULL,
    "submissionId" UUID NOT NULL,
    "supersededSubmissionId" UUID,
    "leftDelta" INTEGER NOT NULL,
    "rightDelta" INTEGER NOT NULL,
    "leftScoreBefore" INTEGER NOT NULL,
    "rightScoreBefore" INTEGER NOT NULL,
    "leftScoreAfter" INTEGER NOT NULL,
    "rightScoreAfter" INTEGER NOT NULL,
    "scoreRevisionBefore" INTEGER NOT NULL,
    "scoreRevisionAfter" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoreLedgerEntry_pkey" PRIMARY KEY ("id")
);

INSERT INTO "ScoreLedgerEntry" (
    "id", "kind", "setId", "submissionId", "supersededSubmissionId",
    "leftDelta", "rightDelta", "leftScoreBefore", "rightScoreBefore",
    "leftScoreAfter", "rightScoreAfter", "scoreRevisionBefore",
    "scoreRevisionAfter", "createdAt"
)
SELECT
    "id", 'POINT_AWARD'::"ScoreLedgerEntryKind", "setId", "submissionId", NULL,
    "leftScoreAfter" - "leftScoreBefore", "rightScoreAfter" - "rightScoreBefore",
    "leftScoreBefore", "rightScoreBefore", "leftScoreAfter", "rightScoreAfter",
    "scoreRevisionBefore", "scoreRevisionAfter", "createdAt"
FROM "PointAward";

ALTER TABLE "PointAward" ADD COLUMN "ledgerEntryId" UUID;
UPDATE "PointAward" SET "ledgerEntryId" = "id";
ALTER TABLE "PointAward" ALTER COLUMN "ledgerEntryId" SET NOT NULL;

CREATE UNIQUE INDEX "ScoreLedgerEntry_submissionId_key" ON "ScoreLedgerEntry"("submissionId");
CREATE UNIQUE INDEX "ScoreLedgerEntry_supersededSubmissionId_key" ON "ScoreLedgerEntry"("supersededSubmissionId");
CREATE UNIQUE INDEX "ScoreLedgerEntry_setId_scoreRevisionAfter_key" ON "ScoreLedgerEntry"("setId", "scoreRevisionAfter");
CREATE INDEX "ScoreLedgerEntry_setId_createdAt_idx" ON "ScoreLedgerEntry"("setId", "createdAt");
CREATE UNIQUE INDEX "PointAward_ledgerEntryId_key" ON "PointAward"("ledgerEntryId");

ALTER TABLE "ScoreLedgerEntry" ADD CONSTRAINT "ScoreLedgerEntry_setId_fkey" FOREIGN KEY ("setId") REFERENCES "MatchSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScoreLedgerEntry" ADD CONSTRAINT "ScoreLedgerEntry_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "RallySubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScoreLedgerEntry" ADD CONSTRAINT "ScoreLedgerEntry_supersededSubmissionId_fkey" FOREIGN KEY ("supersededSubmissionId") REFERENCES "RallySubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PointAward" ADD CONSTRAINT "PointAward_ledgerEntryId_fkey" FOREIGN KEY ("ledgerEntryId") REFERENCES "ScoreLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
