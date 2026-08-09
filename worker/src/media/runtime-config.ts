import { z } from 'zod'

const MediaIndexerEnvironment = z.object({
  DATABASE_URL: z.string().url(),
  MEDIA_IMPORT_ROOT: z.string().min(1),
  MEDIA_INGEST_BASE_URL: z.string().min(1),
  MEDIA_SPOOL_DIR: z.string().min(1),
  MEDIA_SOURCE_WORK_ROOT: z.string().min(1),
  MINIO_ENDPOINT: z.string().url(),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_DVR_BUCKET: z.string().min(3),
  OME_API_ACCESS_TOKEN: z.string().min(32),
  OME_API_URL: z.string().url(),
  MEDIA_INDEXER_SCAN_INTERVAL_MS: z.coerce.number().int().min(250)
    .max(300_000).default(1_000),
  MEDIA_SOURCE_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  MEDIA_SOURCE_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(10_000).default(250),
  YOUTUBE_EXTRACTOR_ARGS: z.string().min(1).default('youtube:player_client=android_vr'),
  YOUTUBE_FORMAT: z.string().min(1).default('best[protocol*=m3u8][height=1080][fps>=59][fps<=61][vcodec^=avc][acodec!=none]/bestvideo[height=1080][fps>=59][fps<=61][vcodec^=avc]+bestaudio[acodec^=mp4a]'),
  YT_DLP_COMMAND: z.string().min(1).default('yt-dlp'),
})

export type MediaIndexerConfig = z.infer<typeof MediaIndexerEnvironment>

export function mediaIndexerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): MediaIndexerConfig {
  return MediaIndexerEnvironment.parse(environment)
}
