import type { PrismaClient } from '@volleyball-monitoring/db'
import type { MatchCleanupDependencies, MatchDeleteReceipt } from './match-administration.js'
import { finalizeMatchDeletion } from './match-administration.js'

export interface MatchCleanupLogger {
  error(fields: Record<string, unknown>, message: string): void
  info(fields: Record<string, unknown>, message: string): void
}

export async function runNextPendingMatchCleanup(
  database: PrismaClient,
  dependencies: MatchCleanupDependencies,
): Promise<MatchDeleteReceipt | null> {
  const pending = await database.match.findFirst({
    orderBy: [{ deletionRequestedAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
    where: { deletionRequestedAt: { not: null } },
  })
  return pending ? finalizeMatchDeletion(pending.id, dependencies) : null
}

export function createMatchCleanupCoordinator(
  dependencies: MatchCleanupDependencies,
  logger: MatchCleanupLogger,
  options: { idleDelayMs?: number; retryDelayMs?: number } = {},
) {
  const idleDelayMs = options.idleDelayMs ?? 1_000
  const retryDelayMs = options.retryDelayMs ?? 5_000
  let stopped = true
  let timer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> | null = null

  const schedule = (delayMs: number) => {
    if (stopped || timer) return
    timer = setTimeout(() => {
      timer = null
      inFlight = runNextPendingMatchCleanup(dependencies.database, dependencies)
        .then(receipt => {
          if (receipt) {
            logger.info(
              {
                matchId: receipt.matchId,
                removedAssetCount: receipt.removedAssetCount,
                removedBytes: receipt.removedBytes,
              },
              'Background match cleanup completed',
            )
          }
          schedule(receipt ? 0 : idleDelayMs)
        })
        .catch(error => {
          logger.error(
            { error },
            'Background match cleanup failed; the durable deletion marker will be retried',
          )
          schedule(retryDelayMs)
        })
        .finally(() => {
          inFlight = null
        })
    }, delayMs)
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      schedule(0)
    },
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      await inFlight
    },
  }
}
