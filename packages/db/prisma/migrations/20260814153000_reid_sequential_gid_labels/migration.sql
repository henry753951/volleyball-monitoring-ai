DROP INDEX "ReidIdentity_matchId_teamId_modelNamespace_label_key";

WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "matchId", "modelNamespace"
      ORDER BY "createdAt", "id"
    ) AS gid_number
  FROM "ReidIdentity"
)
UPDATE "ReidIdentity" AS identity
SET "label" = 'G' || lpad(ranked.gid_number::text, 3, '0')
FROM ranked
WHERE identity."id" = ranked."id";

CREATE UNIQUE INDEX "ReidIdentity_matchId_modelNamespace_label_key"
ON "ReidIdentity"("matchId", "modelNamespace", "label");

ALTER TABLE "ReidIdentity"
ADD CONSTRAINT "ReidIdentity_label_check" CHECK ("label" ~ '^G[0-9]{3,}$');
