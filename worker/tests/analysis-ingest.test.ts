import type { PrismaClient } from '@volleyball-monitoring/db'
import { describe, expect, it } from 'vitest'
import { createAnalysisIngestWorker } from '../src/roles/analysis-ingest.js'

async function eventually(assertion: () => void, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { assertion(); return }
    catch { await new Promise(resolve => setTimeout(resolve, 2)) }
  }
  assertion()
}

describe('analysis ingest convergence worker', () => {
  it('repairs only terminal projections for the active immutable submission', async () => {
    const run = {
      aiJobId: 'ai-1',
      submissionId: 'submission-1',
      aiJob: { status: 'RUNNING' },
      submission: {
        rallyId: 'rally-1',
        rally: { activeSubmissionId: 'submission-1', processingStatus: 'AI_PROCESSING', voidedAt: null },
      },
    }
    let disconnected = false
    let transactions = 0
    const database = {
      analysisRun: { findMany: async () => [run] },
      aiJob: {
        updateMany: ({ data }: { data: Record<string, unknown> }) => ({ execute: () => { Object.assign(run.aiJob, data); return { count: 1 } } }),
      },
      rally: {
        updateMany: ({ data }: { data: Record<string, unknown> }) => ({ execute: () => { Object.assign(run.submission.rally, data); return { count: 1 } } }),
      },
      $transaction: async (operations: Array<{ execute(): unknown }>) => {
        transactions += 1
        return operations.map(operation => operation.execute())
      },
      $disconnect: async () => { disconnected = true },
    } as unknown as PrismaClient
    const worker = createAnalysisIngestWorker(database, { idleMs: 1 })

    await worker.start()
    await eventually(() => {
      expect(run.aiJob.status).toBe('COMPLETED')
      expect(run.submission.rally.processingStatus).toBe('COMPLETED')
    })
    await worker.stop()

    expect(transactions).toBe(1)
    expect(disconnected).toBe(true)
  })

  it('does not reactivate a superseded job or an inactive submission', async () => {
    const run = {
      aiJobId: 'ai-old',
      submissionId: 'submission-old',
      aiJob: { status: 'SUPERSEDED' },
      submission: {
        rallyId: 'rally-1',
        rally: { activeSubmissionId: 'submission-new', processingStatus: 'COMPLETED', voidedAt: null },
      },
    }
    let transactions = 0
    const database = {
      analysisRun: { findMany: async () => [run] },
      aiJob: { updateMany: () => ({}) },
      rally: { updateMany: () => ({}) },
      $transaction: async () => { transactions += 1 },
      $disconnect: async () => undefined,
    } as unknown as PrismaClient
    const worker = createAnalysisIngestWorker(database, { idleMs: 1 })

    await worker.start()
    await new Promise(resolve => setTimeout(resolve, 10))
    await worker.stop()

    expect(transactions).toBe(0)
    expect(run.aiJob.status).toBe('SUPERSEDED')
  })
})
