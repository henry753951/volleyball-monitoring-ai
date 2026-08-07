CREATE TABLE "AnnotationCommandReceipt" (
  "serverSequence" BIGSERIAL NOT NULL,
  "commandId" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "rallyId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "deviceSessionId" UUID NOT NULL,
  "requestHash" TEXT NOT NULL,
  "requestJson" JSONB NOT NULL,
  "accepted" BOOLEAN NOT NULL,
  "responseJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnnotationCommandReceipt_pkey" PRIMARY KEY ("serverSequence")
);

ALTER TABLE "AnnotationOperation"
  ADD COLUMN "receiptServerSequence" BIGINT;

CREATE UNIQUE INDEX "AnnotationCommandReceipt_commandId_key"
  ON "AnnotationCommandReceipt"("commandId");
CREATE INDEX "AnnotationCommandReceipt_room_sequence_idx"
  ON "AnnotationCommandReceipt"("roomId", "serverSequence");
CREATE INDEX "AnnotationCommandReceipt_rally_sequence_idx"
  ON "AnnotationCommandReceipt"("rallyId", "serverSequence");
CREATE UNIQUE INDEX "AnnotationOperation_receiptServerSequence_key"
  ON "AnnotationOperation"("receiptServerSequence");

ALTER TABLE "AnnotationCommandReceipt"
  ADD CONSTRAINT "AnnotationCommandReceipt_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AnnotationCommandReceipt"
  ADD CONSTRAINT "AnnotationCommandReceipt_deviceSessionId_fkey"
  FOREIGN KEY ("deviceSessionId") REFERENCES "DeviceSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AnnotationOperation"
  ADD CONSTRAINT "AnnotationOperation_receiptServerSequence_fkey"
  FOREIGN KEY ("receiptServerSequence") REFERENCES "AnnotationCommandReceipt"("serverSequence") ON DELETE RESTRICT ON UPDATE CASCADE;
