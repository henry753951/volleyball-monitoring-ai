import type { PrismaClient } from '@volleyball-monitoring/db'
import { createPollingLifecycle, type PollingLifecycle } from '../workflow/poller.js'

const DEFAULT_BATCH_SIZE = 100

/**
 * The current deterministic DVR profile is already fragmented MP4, so the
 * Server can build a bounded HLS manifest without transcoding or copying media.
 * This role owns the asynchronous lifecycle of those ephemeral mappings.
 */
export function createPlaybackPackagerWorker(
  database: PrismaClient,
  options: {
    now?: () => Date
    batchSize?: number
    idleMs?: number
    disconnectOnStop?: boolean
    onError?: (error: unknown) => void
  } = {},
): PollingLifecycle {
  const now = options.now ?? (() => new Date())
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000)
    throw new TypeError('playback cleanup batch size must be between 1 and 1000')

  async function processNext(): Promise<boolean> {
    const expired = await database.playbackWindow.findMany({
      where: { expiresAt: { lte: now() } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
      take: batchSize,
    })
    if (!expired.length) return false
    await database.playbackWindow.deleteMany({
      where: { id: { in: expired.map(window => window.id) } },
    })
    return true
  }

  return createPollingLifecycle(processNext, {
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    onError: error => {
      console.error(
        'playback-packager loop error',
        error instanceof Error ? error.name : 'UnknownError',
      )
      options.onError?.(error)
    },
    ...(options.disconnectOnStop === false ? {} : { disconnect: () => database.$disconnect() }),
  })
}
