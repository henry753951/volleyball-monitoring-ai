import { z } from 'zod'

const ipv4 = z.string().refine((value) => {
  const parts = value.split('.')
  return parts.length === 4
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}, 'invalid IPv4 bind address')

const MediaIndexerEnvironment = z.object({
  DATABASE_URL: z.string().url(),
  MEDIA_SPOOL_DIR: z.string().min(1),
  MINIO_ENDPOINT: z.string().url(),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_DVR_BUCKET: z.string().min(3),
  MEDIA_INDEXER_HOOK_TOKEN: z.string().min(16),
  MEDIA_INDEXER_HOOK_PORT: z.coerce.number().int().min(1).max(65_535)
    .default(4_100),
  MEDIA_INDEXER_HOOK_BIND: ipv4.default('0.0.0.0'),
  MEDIA_INDEXER_SCAN_INTERVAL_MS: z.coerce.number().int().min(1_000)
    .max(300_000).default(10_000),
})

export type MediaIndexerConfig = z.infer<typeof MediaIndexerEnvironment>

export function mediaIndexerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): MediaIndexerConfig {
  return MediaIndexerEnvironment.parse(environment)
}
