CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "ReidSearchEmbedding" (
  "featureVectorId" UUID NOT NULL,
  "modelNamespace" TEXT NOT NULL,
  "modality" TEXT NOT NULL,
  "dimension" INTEGER NOT NULL,
  "distance" TEXT NOT NULL,
  "embedding" vector NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReidSearchEmbedding_pkey" PRIMARY KEY ("featureVectorId"),
  CONSTRAINT "ReidSearchEmbedding_featureVectorId_fkey"
    FOREIGN KEY ("featureVectorId") REFERENCES "ReidFeatureVector"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ReidSearchEmbedding_indexable_dimension_check"
    CHECK ("dimension" BETWEEN 1 AND 2000),
  CONSTRAINT "ReidSearchEmbedding_distance_check"
    CHECK ("distance" IN ('COSINE', 'EUCLIDEAN'))
);

CREATE INDEX "ReidSearchEmbedding_namespace_modality_dimension_distance_idx"
  ON "ReidSearchEmbedding"("modelNamespace", "modality", "dimension", "distance");

CREATE INDEX "ReidSearchEmbedding_cosine_384_hnsw_idx"
  ON "ReidSearchEmbedding"
  USING hnsw (("embedding"::vector(384)) vector_cosine_ops)
  WHERE "dimension" = 384 AND "distance" = 'COSINE';

CREATE INDEX "ReidSearchEmbedding_cosine_512_hnsw_idx"
  ON "ReidSearchEmbedding"
  USING hnsw (("embedding"::vector(512)) vector_cosine_ops)
  WHERE "dimension" = 512 AND "distance" = 'COSINE';
