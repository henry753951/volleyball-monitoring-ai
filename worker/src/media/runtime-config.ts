import { z } from 'zod'

const YOUTUBE_PROBE_FORMAT =
  'best[protocol*=m3u8][height=1080][fps>=59][fps<=61][vcodec^=avc][acodec!=none]/bestvideo[height=1080][fps>=59][fps<=61][vcodec^=avc]+bestaudio[acodec^=mp4a]/bestvideo[height=1080][vcodec^=avc]+bestaudio[acodec^=mp4a]/best[height=1080][vcodec^=avc][acodec!=none]/best[protocol*=m3u8][height<=1080][vcodec^=avc][acodec!=none]/bestvideo[height<=1080][vcodec^=avc]+bestaudio[acodec^=mp4a]/best[height<=1080][vcodec^=avc][acodec!=none]'
const YOUTUBE_VOD_FORMAT =
  'bestvideo[protocol^=http][height=1080][fps>=59][fps<=61][vcodec^=avc]+bestaudio[protocol^=http][acodec^=mp4a]/bestvideo[protocol^=http][height=1080][vcodec^=avc]+bestaudio[protocol^=http][acodec^=mp4a]/bestvideo[height=1080][vcodec^=avc]+bestaudio[acodec^=mp4a]/best[height=1080][vcodec^=avc][acodec!=none]/bestvideo[protocol^=http][height<=1080][vcodec^=avc]+bestaudio[protocol^=http][acodec^=mp4a]/bestvideo[height<=1080][vcodec^=avc]+bestaudio[acodec^=mp4a]/best[height<=1080][vcodec^=avc][acodec!=none]'

const MediaIndexerEnvironment = z.object({
  DATABASE_URL: z.string().url(),
  MEDIA_IMPORT_ROOT: z.string().min(1),
  MEDIA_INGEST_BASE_URL: z.string().min(1),
  MEDIA_SPOOL_DIR: z.string().min(1),
  MEDIA_SOURCE_WORK_ROOT: z.string().min(1),
  MEDIA_HOT_ROOT: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).optional(),
  ),
  MEDIA_ARCHIVE_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
  MINIO_ENDPOINT: z.string().url(),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_DVR_BUCKET: z.string().min(3),
  OME_API_ACCESS_TOKEN: z.string().min(32),
  OME_API_URL: z.string().url(),
  OME_LLHLS_URL: z.string().url().default('http://127.0.0.1:3333'),
  MEDIA_INDEXER_SCAN_INTERVAL_MS: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
  MEDIA_INDEXER_ACTIVE_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(10_000).default(500),
  MEDIA_SOURCE_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  MEDIA_SOURCE_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(10_000).default(250),
  YOUTUBE_COOKIES_FILE: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().min(1).optional(),
  ),
  YOUTUBE_EXTRACTOR_ARGS: z.string().min(1).default('youtube:player_client=default'),
  YOUTUBE_FORMAT: z.string().min(1).default(YOUTUBE_PROBE_FORMAT),
  YOUTUBE_LIVE_EXTRACTOR_ARGS: z.string().min(1).default('youtube:player_client=mweb'),
  YOUTUBE_LIVE_MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().min(1).max(100).default(5),
  YOUTUBE_POT_PROVIDER_URL: z.preprocess(
    value => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().url().optional(),
  ),
  YOUTUBE_VOD_EXTRACTOR_ARGS: z.string().min(1).default('youtube:player_client=visionos'),
  YOUTUBE_VOD_FORMAT: z.string().min(1).default(YOUTUBE_VOD_FORMAT),
  YT_DLP_COMMAND: z.string().min(1).default('yt-dlp'),
})

export type MediaIndexerConfig = z.infer<typeof MediaIndexerEnvironment>

export function mediaIndexerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): MediaIndexerConfig {
  return MediaIndexerEnvironment.parse(environment)
}
