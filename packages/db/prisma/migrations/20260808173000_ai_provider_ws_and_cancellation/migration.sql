ALTER TYPE "ProcessingStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

CREATE TYPE "AiTransportMode" AS ENUM ('HTTP_PUSH', 'WS_AGENT');

ALTER TABLE "AiIntegration"
  ADD COLUMN "transportMode" "AiTransportMode" NOT NULL DEFAULT 'HTTP_PUSH',
  ALTER COLUMN "submitUrl" DROP NOT NULL;

CREATE TABLE "AiProviderInstance" (
  "id" UUID NOT NULL,
  "integrationId" UUID NOT NULL,
  "instanceKey" TEXT NOT NULL,
  "sdkVersion" TEXT NOT NULL,
  "providerBuildId" TEXT NOT NULL,
  "capabilities" JSONB NOT NULL,
  "maxConcurrency" INTEGER NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "disconnectedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiProviderInstance_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AiJob"
  ADD COLUMN "providerInstanceId" UUID,
  ADD COLUMN "deliveryId" UUID,
  ADD COLUMN "cancelRequestedAt" TIMESTAMP(3),
  ADD COLUMN "cancelAcknowledgedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "AiProviderInstance_integrationId_instanceKey_key"
  ON "AiProviderInstance"("integrationId", "instanceKey");
CREATE INDEX "AiProviderInstance_integrationId_lastSeenAt_idx"
  ON "AiProviderInstance"("integrationId", "lastSeenAt");
CREATE INDEX "AiJob_providerInstanceId_status_idx"
  ON "AiJob"("providerInstanceId", "status");

ALTER TABLE "AiProviderInstance"
  ADD CONSTRAINT "AiProviderInstance_integrationId_fkey"
  FOREIGN KEY ("integrationId") REFERENCES "AiIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiJob"
  ADD CONSTRAINT "AiJob_providerInstanceId_fkey"
  FOREIGN KEY ("providerInstanceId") REFERENCES "AiProviderInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
