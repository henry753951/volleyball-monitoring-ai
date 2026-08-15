import type { PrismaClient } from '@volleyball-monitoring/db'
import { createPollingLifecycle, type PollingLifecycle } from '../workflow/poller.js'

const SCAN_BATCH_SIZE = 100

/**
 * Completed callbacks are validated and normalized atomically by the REST
 * boundary so idempotent callback receipts never acknowledge partial data.
 * This worker is the durable convergence path after process/database restarts:
 * it repairs only terminal status projections for the active immutable
 * submission and never rewrites normalized analysis or provider court_pos.
 */
export function createAnalysisIngestWorker(
  database: PrismaClient,
  options: {
    idleMs?: number
    disconnectOnStop?: boolean
    onError?: (error: unknown) => void
  } = {},
): PollingLifecycle {
  async function processNext(): Promise<boolean> {
    const candidates = await database.analysisRun.findMany({
      where: { status: 'COMPLETED' },
      orderBy: [{ activatedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: SCAN_BATCH_SIZE,
      select: {
        aiJobId: true,
        submissionId: true,
        aiJob: { select: { status: true } },
        submission: {
          select: {
            rallyId: true,
            rally: { select: { activeSubmissionId: true, processingStatus: true, voidedAt: true } },
          },
        },
      },
    })
    const candidate = candidates.find(run => {
      const active =
        run.submission.rally.activeSubmissionId === run.submissionId &&
        run.submission.rally.voidedAt === null
      const aiNeedsConvergence = !['COMPLETED', 'SUPERSEDED'].includes(run.aiJob.status)
      const rallyNeedsConvergence = active && run.submission.rally.processingStatus !== 'COMPLETED'
      return aiNeedsConvergence || rallyNeedsConvergence
    })
    if (!candidate) return false

    await database.$transaction([
      database.aiJob.updateMany({
        where: { id: candidate.aiJobId, status: { notIn: ['COMPLETED', 'SUPERSEDED'] } },
        data: {
          status: 'COMPLETED',
          progress: 1,
          stage: 'completed',
          leasedUntil: null,
          completedAt: new Date(),
        },
      }),
      database.rally.updateMany({
        where: {
          id: candidate.submission.rallyId,
          activeSubmissionId: candidate.submissionId,
          voidedAt: null,
          processingStatus: { not: 'COMPLETED' },
        },
        data: { processingStatus: 'COMPLETED' },
      }),
    ])
    return true
  }

  return createPollingLifecycle(processNext, {
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    onError: error => {
      console.error(
        'analysis-ingest loop error',
        error instanceof Error ? error.name : 'UnknownError',
      )
      options.onError?.(error)
    },
    ...(options.disconnectOnStop === false ? {} : { disconnect: () => database.$disconnect() }),
  })
}
