import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import {
  MEDIA_INGEST_QUEUE,
  PermanentMediaIngestError,
  createPgBossMediaRuntime,
  mediaIngestQueueOptions,
} from '../src/roles/media-indexer'

const databaseUrl = process.env.PG_BOSS_TEST_DATABASE_URL ?? process.env.DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
const databaseName = `pgboss_phase2a_${process.pid}_${Math.random().toString(16).slice(2, 10)}`

let isolatedDatabaseUrl = ''
let admin: pg.Pool

if (databaseUrl) {
  beforeAll(async () => {
    const parsed = new URL(databaseUrl)
    admin = new pg.Pool({ connectionString: databaseUrl })
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    parsed.pathname = `/${databaseName}`
    isolatedDatabaseUrl = parsed.toString()
  })

  afterAll(async () => {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
      [databaseName],
    )
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
    await admin.end()
  })
}

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

async function eventually<T>(
  probe: () => Promise<T | null | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await probe()
    if (result !== null && result !== undefined) return result
    await wait(100)
  }
  throw new Error(`condition was not met within ${timeoutMs} ms`)
}

function requireJobId(id: string | null): string {
  expect(id).toBeTypeOf('string')
  if (!id) throw new Error('pg-boss did not return a job id')
  return id
}

function envelope(
  captureSessionId: string,
  sourceOrder = '1',
  epochCandidateId = captureSessionId,
) {
  return {
    schemaVersion: '1.0.0' as const,
    jobType: MEDIA_INGEST_QUEUE as const,
    captureSessionId,
    candidate: 'cam/2026-01-01_00-00-00-000001.m4s',
    sourceOrder,
    epochCandidateId,
    sourceRestart: false,
    timestampDiscontinuity: false,
    explicitGapBeforeUs: null,
  }
}

integration('pg-boss media runtime integration', () => {
  it('persists the queue policy and consumes a singleton job', async () => {
    const seen: string[] = []
    const runtime = createPgBossMediaRuntime(isolatedDatabaseUrl, async item => {
      seen.push(item.captureSessionId)
    })
    await runtime.start()

    try {
      const queue = await runtime.boss.getQueue(MEDIA_INGEST_QUEUE)
      expect(queue?.policy).toBe(mediaIngestQueueOptions.policy)
      expect(queue?.partition).toBe(true)

      const item = envelope('00000000-0000-4000-8000-000000000001')
      const id = requireJobId(await runtime.send(item))
      expect(await runtime.send(item)).toBeNull()
      const completed = await eventually(async () => {
        const job = await runtime.boss.getJobById(MEDIA_INGEST_QUEUE, id)
        return job?.state === 'completed' ? job : null
      })

      expect(completed.state).toBe('completed')
      expect(seen).toEqual(['00000000-0000-4000-8000-000000000001'])
      expect(await runtime.send(item)).toBeNull()
    } finally {
      await runtime.stop()
    }
  })

  it('dead-letters permanent failures with sanitized output', async () => {
    const runtime = createPgBossMediaRuntime(isolatedDatabaseUrl, async () => {
      throw new PermanentMediaIngestError('PERMANENT_FAILURE')
    })
    await runtime.start()

    try {
      const sourceId = requireJobId(
        await runtime.send(envelope('00000000-0000-4000-8000-000000000002')),
      )
      const deadLetter = await eventually(async () => {
        const jobs = await runtime.boss.findJobs(mediaIngestQueueOptions.deadLetter)
        return jobs.find(job => (job.data as { sourceJobId?: string }).sourceJobId === sourceId)
      })

      expect((deadLetter.data as { permanentFailure?: unknown }).permanentFailure).toEqual({
        code: 'PERMANENT_FAILURE',
      })
      expect((deadLetter.data as { sourceQueue?: string }).sourceQueue).toBe(MEDIA_INGEST_QUEUE)
      expect((await runtime.boss.getJobById(MEDIA_INGEST_QUEUE, sourceId))?.state).toBe('completed')
    } finally {
      await runtime.stop()
    }
  })

  it('keeps same-capture jobs FIFO while accepting an independent capture', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    const captureA = '00000000-0000-4000-8000-000000000011'
    const captureB = '00000000-0000-4000-8000-000000000012'
    const runtime = createPgBossMediaRuntime(isolatedDatabaseUrl, async item => {
      order.push(`${item.captureSessionId}:${item.sourceOrder}`)
      if (item.captureSessionId === captureA && item.sourceOrder === '1') {
        await firstGate
      }
    })
    await runtime.start()

    try {
      const first = requireJobId(await runtime.send(envelope(captureA, '1')))
      const second = requireJobId(
        await runtime.send(envelope(captureA, '2', '00000000-0000-4000-8000-0000000000a2')),
      )
      const independent = requireJobId(
        await runtime.send(envelope(captureB, '1', '00000000-0000-4000-8000-0000000000b1')),
      )
      expect(new Set([first, second, independent]).size).toBe(3)

      await wait(400)
      expect(order.filter(item => item.startsWith(captureA))).toEqual([`${captureA}:1`])

      releaseFirst()
      await eventually(async () => {
        const captureAOrder = order.filter(item => item.startsWith(captureA))
        return captureAOrder.length === 2 ? captureAOrder : null
      })
      expect(order.filter(item => item.startsWith(captureA))).toEqual([
        `${captureA}:1`,
        `${captureA}:2`,
      ])
    } finally {
      releaseFirst()
      await runtime.stop()
    }
  })

  it('retries a transient failure and completes without dead-lettering', async () => {
    let attempts = 0
    const captureSessionId = '00000000-0000-4000-8000-000000000099'
    const runtime = createPgBossMediaRuntime(isolatedDatabaseUrl, async () => {
      attempts += 1
      if (attempts === 1) throw new Error('temporary database outage')
    })
    await runtime.start()

    try {
      const sourceId = requireJobId(await runtime.send(envelope(captureSessionId)))
      const completed = await eventually(async () => {
        const job = await runtime.boss.getJobById(MEDIA_INGEST_QUEUE, sourceId)
        return job?.state === 'completed' ? job : null
      }, 15_000)

      expect(attempts).toBe(2)
      expect(completed.state).toBe('completed')
      const deadLetters = await runtime.boss.findJobs(mediaIngestQueueOptions.deadLetter)
      expect(deadLetters.some(job => job.sourceId === sourceId)).toBe(false)
    } finally {
      await runtime.stop()
    }
  }, 30_000)

  it('preserves completed state across a runtime restart', async () => {
    const captureSessionId = '00000000-0000-4000-8000-0000000000aa'
    let runtimeADeliveries = 0
    const runtimeA = createPgBossMediaRuntime(isolatedDatabaseUrl, async () => {
      runtimeADeliveries += 1
    })
    await runtimeA.start()

    let completedId = ''
    try {
      completedId = requireJobId(await runtimeA.send(envelope(captureSessionId)))
      await eventually(async () => {
        const job = await runtimeA.boss.getJobById(MEDIA_INGEST_QUEUE, completedId)
        return job?.state === 'completed' ? job : null
      })
      expect(runtimeADeliveries).toBe(1)
    } finally {
      await runtimeA.stop()
    }

    let runtimeBDeliveries = 0
    const runtimeB = createPgBossMediaRuntime(isolatedDatabaseUrl, async () => {
      runtimeBDeliveries += 1
    })
    await runtimeB.start()

    try {
      const persisted = await runtimeB.boss.getJobById(MEDIA_INGEST_QUEUE, completedId)
      expect(persisted?.state).toBe('completed')
      await wait(400)
      expect(runtimeBDeliveries).toBe(0)

      const secondId = requireJobId(
        await runtimeB.send(
          envelope(captureSessionId, '2', '00000000-0000-4000-8000-0000000000c2'),
        ),
      )
      await eventually(async () => {
        const job = await runtimeB.boss.getJobById(MEDIA_INGEST_QUEUE, secondId)
        return job?.state === 'completed' ? job : null
      })
      expect(runtimeBDeliveries).toBe(1)
      expect(runtimeADeliveries).toBe(1)
    } finally {
      await runtimeB.stop()
    }
  })

  it('dead-letters a malformed payload with INVALID_JOB and no sensitive output', async () => {
    let handlerDeliveries = 0
    const runtime = createPgBossMediaRuntime(isolatedDatabaseUrl, async () => {
      handlerDeliveries += 1
    })
    await runtime.start()

    try {
      const sourceId = requireJobId(
        await runtime.boss.send(
          MEDIA_INGEST_QUEUE,
          { candidate: '/private/camera/path', token: 'do-not-leak-this-token' },
          { singletonKey: '00000000-0000-4000-8000-0000000000bb' },
        ),
      )
      const deadLetter = await eventually(async () => {
        const jobs = await runtime.boss.findJobs(mediaIngestQueueOptions.deadLetter)
        return jobs.find(job => (job.data as { sourceJobId?: string }).sourceJobId === sourceId)
      })

      expect(handlerDeliveries).toBe(0)
      expect((deadLetter.data as { permanentFailure?: unknown }).permanentFailure).toEqual({
        code: 'INVALID_JOB',
      })
      expect(JSON.stringify(deadLetter.data)).not.toContain('private')
      expect(JSON.stringify(deadLetter.data)).not.toContain('do-not-leak')
    } finally {
      await runtime.stop()
    }
  })
})
