-- Collapse the obsolete provider-integration layer into one global AI engine.
-- The deployment has a single WS worker service, so credentials, instances and
-- durable jobs no longer need an integration foreign key.

ALTER TABLE "AiIntegrationAccessToken"
  DROP CONSTRAINT "AiIntegrationAccessToken_integrationId_fkey";
ALTER TABLE "AiProviderInstance"
  DROP CONSTRAINT "AiProviderInstance_integrationId_fkey";
ALTER TABLE "AiJob"
  DROP CONSTRAINT "AiJob_integrationId_fkey";

DROP INDEX "AiIntegrationAccessToken_integrationId_name_key";
DROP INDEX "AiIntegrationAccessToken_integrationId_enabled_idx";
DROP INDEX "AiProviderInstance_integrationId_instanceKey_key";
DROP INDEX "AiProviderInstance_integrationId_lastSeenAt_idx";

ALTER TABLE "AiIntegrationAccessToken" RENAME TO "AiWorkerAccessToken";
ALTER TABLE "AiWorkerAccessToken" RENAME CONSTRAINT "AiIntegrationAccessToken_pkey" TO "AiWorkerAccessToken_pkey";
ALTER INDEX "AiIntegrationAccessToken_tokenHash_key" RENAME TO "AiWorkerAccessToken_tokenHash_key";

ALTER TABLE "AiWorkerAccessToken" DROP COLUMN "integrationId";
ALTER TABLE "AiProviderInstance" DROP COLUMN "integrationId";
ALTER TABLE "AiJob" DROP COLUMN "integrationId";

CREATE UNIQUE INDEX "AiWorkerAccessToken_name_key" ON "AiWorkerAccessToken"("name");
CREATE INDEX "AiWorkerAccessToken_enabled_idx" ON "AiWorkerAccessToken"("enabled");
CREATE UNIQUE INDEX "AiProviderInstance_instanceKey_key" ON "AiProviderInstance"("instanceKey");
CREATE INDEX "AiProviderInstance_lastSeenAt_idx" ON "AiProviderInstance"("lastSeenAt");

DROP TABLE "AiIntegration";
DROP TYPE "AiTransportMode";
