import type { PrismaClient } from '@volleyball-monitoring/db'
import { describe, expect, it } from 'vitest'
import { mediaSourceRetryDelay } from '../src/media/source-runtime.js'
import {
  claimDrainingMediaSourceWork,
  claimMediaSourceWork,
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
})
