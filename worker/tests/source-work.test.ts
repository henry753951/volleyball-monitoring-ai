import type { PrismaClient } from '@volleyball-monitoring/db'
import { describe, expect, it } from 'vitest'
import {
  mediaSourceCheckpointProgressed,
  mediaSourceRetryDelay,
} from '../src/media/source-runtime.js'
import {
  claimDrainingMediaSourceWork,
  claimMediaSourceWork,
  listCompletedMediaSpoolCandidates,
  recordPermanentMediaIngestFailure,
  recordMediaSourceRelayError,
  recordMediaSourceRelayHealthy,
} from '../src/media/source-work.js'

function queryRecorder() {
  const queries: string[] = []
  const database = {
    $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      queries.push(
        strings.reduce(
          (sql, part, index) => `${sql}${part}${index < values.length ? '?' : ''}`,
          '',
        ),
      )
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

  it('resets a bounded retry budget only after the durable VOD checkpoint advances', () => {
    expect(mediaSourceCheckpointProgressed(182, 910_023_242n, 183, 915_023_242n)).toBe(true)
    expect(mediaSourceCheckpointProgressed(182, 910_023_242n, 182, 910_023_242n)).toBe(false)
    expect(mediaSourceCheckpointProgressed(182, 910_023_242n, 183, 910_023_242n)).toBe(false)
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
        upsert: () =>
          Promise.reject(Object.assign(new Error('capture deleted'), { code: 'P2003' })),
      },
    }
    await expect(
      recordPermanentMediaIngestFailure(database as never, {
        sourceJobId: crypto.randomUUID(),
        captureSessionId: crypto.randomUUID(),
        code: 'source_failed',
      }),
    ).resolves.toBeUndefined()
  })

  it('does not hide unrelated persistence failures', async () => {
    const failure = Object.assign(new Error('database unavailable'), { code: 'P1001' })
    const database = { mediaIngestFailure: { upsert: () => Promise.reject(failure) } }
    await expect(
      recordPermanentMediaIngestFailure(database as never, {
        sourceJobId: crypto.randomUUID(),
        captureSessionId: crypto.randomUUID(),
        code: 'source_failed',
      }),
    ).rejects.toBe(failure)
  })
})

describe('recordMediaSourceRelayError', () => {
  it('records only the current owner relay failure and can clear it after OME observes the source', async () => {
    const updates: unknown[] = []
    const database = {
      mediaSourceWork: {
        updateMany: async (input: unknown) => {
          updates.push(input)
          return { count: 1 }
        },
      },
    }

    await expect(
      recordMediaSourceRelayError(
        database as never,
        'work-id',
        'worker-a',
        'MEDIA command failed!',
      ),
    ).resolves.toBe(1)
    await recordMediaSourceRelayError(database as never, 'work-id', 'worker-a', null)

    expect(updates).toEqual([
      {
        data: { lastErrorCode: 'MEDIA_COMMAND_FAILED_' },
        where: { id: 'work-id', leaseOwner: 'worker-a', status: 'RUNNING' },
      },
      {
        data: { lastErrorCode: null },
        where: { id: 'work-id', leaseOwner: 'worker-a', status: 'RUNNING' },
      },
    ])
  })

  it('resets the durable retry budget after independently observed source progress', async () => {
    const updates: unknown[] = []
    const database = {
      mediaSourceWork: {
        updateMany: async (input: unknown) => {
          updates.push(input)
          return { count: 1 }
        },
      },
    }

    await expect(
      recordMediaSourceRelayHealthy(database as never, 'work-id', 'worker-a'),
    ).resolves.toBe(1)
    expect(updates).toEqual([
      {
        data: { attempts: 0, lastErrorCode: null },
        where: { id: 'work-id', leaseOwner: 'worker-a', status: 'RUNNING' },
      },
    ])
  })
})
