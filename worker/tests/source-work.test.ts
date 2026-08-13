import type { PrismaClient } from '@volleyball-monitoring/db'
import { describe, expect, it } from 'vitest'
import { mediaSourceRetryDelay } from '../src/media/source-runtime.js'
import {
  claimDrainingMediaSourceWork,
  claimMediaSourceWork,
  listCompletedMediaSpoolCandidates,
  recordPermanentMediaIngestFailure,
} from '../src/media/source-work.js'

function queryRecorder() {
  const queries: string[] = []
  const database = {
    $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      queries.push(strings.reduce((sql, part, index) => `${sql}${part}${index < values.length ? '?' : ''}`, ''))
      return Promise.resolve([])
    },
  } as unknown as PrismaClient
  return { database, queries }
}

describe('media source work scheduling', () => {
  it('keeps durable draining work out of scarce source execution slots', async () => {
    const runnable = queryRecorder()
    await claimMediaSourceWork(runnable.database, 'worker-a', 2)
    expect(runnable.queries[0]).toContain(`work."status" = 'REQUESTED'`)
    expect(runnable.queries[0]).toContain(`work."status" = 'RUNNING'`)
    expect(runnable.queries[0]).not.toContain(`work."status" = 'DRAINING'`)

    const draining = queryRecorder()
    await claimDrainingMediaSourceWork(draining.database, 'worker-a', 16)
    expect(draining.queries[0]).toContain(`work."status" = 'DRAINING'`)
    expect(draining.queries[0]).not.toContain(`"attempts" = work."attempts" + 1`)
  })

  it('keeps scheduled live streams retryable without hiding ordinary terminal failures', () => {
    expect(mediaSourceRetryDelay('YOUTUBE_UPCOMING', 100, 5)).toBe(30_000)
    expect(mediaSourceRetryDelay('MEDIA_COMMAND_FAILED', 4, 5)).toBe(8_000)
    expect(mediaSourceRetryDelay('MEDIA_COMMAND_FAILED', 5, 5)).toBeNull()
  })

  it('selects cleanup candidates only after every expected artifact is durable', async () => {
    const recorded = queryRecorder()
    await listCompletedMediaSpoolCandidates(recorded.database)
    expect(recorded.queries[0]).toContain(`work."status" = 'COMPLETED'`)
    expect(recorded.queries[0]).toContain(`capture."status" = 'FINISHED'`)
    expect(recorded.queries[0]).toContain(`init."state" = 'READY'`)
    expect(recorded.queries[0]).toContain(`media."state" = 'READY'`)
    expect(recorded.queries[0]).toContain(`sample."state" = 'READY'`)
    expect(recorded.queries[0]).toContain(`"MediaIngestFailure"`)
  })
})

describe('recordPermanentMediaIngestFailure', () => {
  it('ignores the expected FK race after match deletion removes the capture', async () => {
    const database = {
      mediaIngestFailure: {
        upsert: () => Promise.reject(Object.assign(new Error('capture deleted'), { code: 'P2003' })),
      },
    }
    await expect(recordPermanentMediaIngestFailure(database as never, {
      sourceJobId: crypto.randomUUID(),
      captureSessionId: crypto.randomUUID(),
      code: 'source_failed',
    })).resolves.toBeUndefined()
  })

  it('does not hide unrelated persistence failures', async () => {
    const failure = Object.assign(new Error('database unavailable'), { code: 'P1001' })
    const database = { mediaIngestFailure: { upsert: () => Promise.reject(failure) } }
    await expect(recordPermanentMediaIngestFailure(database as never, {
      sourceJobId: crypto.randomUUID(),
      captureSessionId: crypto.randomUUID(),
      code: 'source_failed',
    })).rejects.toBe(failure)
  })
})
