ALTER TYPE "ScoreLedgerEntryKind" ADD VALUE IF NOT EXISTS 'CORRECTION_ROLLBACK';

DROP INDEX IF EXISTS "ScoreLedgerEntry_submissionId_key";
DROP INDEX IF EXISTS "ScoreLedgerEntry_supersededSubmissionId_key";

ALTER TABLE "ScoreLedgerEntry"
  ADD COLUMN "reversalOfEntryId" UUID;

CREATE UNIQUE INDEX "ScoreLedgerEntry_reversalOfEntryId_key"
  ON "ScoreLedgerEntry"("reversalOfEntryId");

ALTER TABLE "ScoreLedgerEntry"
  ADD CONSTRAINT "ScoreLedgerEntry_reversalOfEntryId_fkey"
  FOREIGN KEY ("reversalOfEntryId") REFERENCES "ScoreLedgerEntry"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
