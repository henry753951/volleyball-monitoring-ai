-- A hard-cut AnalysisRun without a VAD1 asset is not usable by current clients.
-- Retire it without deleting normalized rows or sparse human corrections.
UPDATE "AnalysisRun"
SET "status" = 'SUPERSEDED',
    "activatedAt" = NULL,
    "supersededAt" = COALESCE("supersededAt", CURRENT_TIMESTAMP)
WHERE "rawAnalysisDataAssetId" IS NULL
  AND "status" = 'COMPLETED';

UPDATE "AiJob" AS job
SET "status" = 'SUPERSEDED',
    "leasedUntil" = NULL
WHERE job."status" = 'COMPLETED'
  AND EXISTS (
    SELECT 1
    FROM "AnalysisRun" AS run
    WHERE run."aiJobId" = job."id"
      AND run."rawAnalysisDataAssetId" IS NULL
      AND run."status" = 'SUPERSEDED'
  );

UPDATE "Rally" AS rally
SET "processingStatus" = 'IDLE'
WHERE rally."processingStatus" = 'COMPLETED'
  AND NOT EXISTS (
    SELECT 1
    FROM "RallySubmission" AS submission
    JOIN "AnalysisRun" AS run ON run."submissionId" = submission."id"
    WHERE submission."rallyId" = rally."id"
      AND run."status" = 'COMPLETED'
      AND run."rawAnalysisDataAssetId" IS NOT NULL
  );
