CREATE TABLE "AiIntegrationAccessToken" (
    "id" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiIntegrationAccessToken_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AiProviderInstance"
ADD COLUMN "latencyMs" INTEGER,
ADD COLUMN "lastPingAt" TIMESTAMP(3),
ADD COLUMN "lastPongAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "AiIntegrationAccessToken_tokenHash_key" ON "AiIntegrationAccessToken"("tokenHash");
CREATE UNIQUE INDEX "AiIntegrationAccessToken_integrationId_name_key" ON "AiIntegrationAccessToken"("integrationId", "name");
CREATE INDEX "AiIntegrationAccessToken_integrationId_enabled_idx" ON "AiIntegrationAccessToken"("integrationId", "enabled");

ALTER TABLE "AiIntegrationAccessToken"
ADD CONSTRAINT "AiIntegrationAccessToken_integrationId_fkey"
FOREIGN KEY ("integrationId") REFERENCES "AiIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
