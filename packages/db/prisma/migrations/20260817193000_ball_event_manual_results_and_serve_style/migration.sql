CREATE TYPE "BallServeStyle" AS ENUM ('JUMP', 'STANDING');

ALTER TABLE "BallEventDraft"
ADD COLUMN "serveStyle" "BallServeStyle";

ALTER TABLE "RallySubmissionBallEvent"
ADD COLUMN "serveStyle" "BallServeStyle";

UPDATE "BallEventDraft"
SET "serveStyle" = 'JUMP'
WHERE "kind" = 'SERVE';

UPDATE "RallySubmissionBallEvent"
SET "serveStyle" = 'JUMP'
WHERE "kind" = 'SERVE';
