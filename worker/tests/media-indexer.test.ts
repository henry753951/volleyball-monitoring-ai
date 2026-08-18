import { describe, expect, it } from 'vitest'
import {
  assignQueuedIngestGroups,
  MEDIA_INGEST_QUEUE,
  quarantineBlockedCaptureJobs,
  quarantinePermanentMediaFailures,
  reconcilePermanentMediaFailures,
  type MediaIngestEnvelope,
} from '../src/roles/media-indexer.js'
import type { PgBoss } from 'pg-boss'

describe('media ingest failure quarantine', () => {
  it('keeps the audit copy and preserves the strict FIFO failure sentinel', async () => {
    const envelope = {
      schemaVersion: '1.0.0',
      jobType: MEDIA_INGEST_QUEUE,
      captureSessionId: '10000000-0000-4000-8000-000000000001',
      candidate: 'match/main/segment.mp4',
      sourceOrder: '1',
      epochCandidateId: '10000000-0000-4000-8000-000000000002',
      sourceRestart: false,
      timestampDiscontinuity: false,
      explicitGapBeforeUs: null,
    } satisfies MediaIngestEnvelope
    const quarantined: Record<string, unknown>[] = []
    const failures: Record<string, unknown>[] = []
    const blockedCaptureIds: string[] = []

    const results = await quarantinePermanentMediaFailures(
      [{ id: envelope.epochCandidateId, data: envelope }],
      [
        {
          id: envelope.epochCandidateId,
          status: 'deadletter',
          output: { code: 'PERMANENT_FAILURE' },
        },
      ],
      async (_id, data) => {
        quarantined.push(data)
      },
      async failure => {
        failures.push(failure)
      },
      async captureSessionId => {
        blockedCaptureIds.push(captureSessionId)
      },
    )

    expect(results).toEqual([
      {
        id: envelope.epochCandidateId,
        status: 'deadletter',
        output: { code: 'PERMANENT_FAILURE' },
      },
    ])
    expect(quarantined).toEqual([
      expect.objectContaining({
        captureSessionId: envelope.captureSessionId,
        permanentFailure: { code: 'PERMANENT_FAILURE' },
        sourceJobId: envelope.epochCandidateId,
        sourceQueue: MEDIA_INGEST_QUEUE,
      }),
    ])
    expect(failures).toEqual([
      {
        captureSessionId: envelope.captureSessionId,
        code: 'PERMANENT_FAILURE',
        sourceJobId: envelope.epochCandidateId,
      },
    ])
    expect(blockedCaptureIds).toEqual([envelope.captureSessionId])
  })

  it('does not copy malformed source data into the quarantine record', async () => {
    const quarantined: Record<string, unknown>[] = []
    await quarantinePermanentMediaFailures(
      [
        {
          id: '10000000-0000-4000-8000-000000000099',
          data: {
            candidate: '/private/camera/path',
            token: 'do-not-leak-this-token',
          } as unknown as MediaIngestEnvelope,
        },
      ],
      [
        {
          id: '10000000-0000-4000-8000-000000000099',
          status: 'deadletter',
          output: { code: 'INVALID_JOB' },
        },
      ],
      async (_id, data) => {
        quarantined.push(data)
      },
      async () => {
        throw new Error('malformed jobs must not be recorded')
      },
    )

    expect(quarantined).toEqual([
      {
        permanentFailure: { code: 'INVALID_JOB' },
        sourceJobId: '10000000-0000-4000-8000-000000000099',
        sourceQueue: MEDIA_INGEST_QUEUE,
      },
    ])
    expect(JSON.stringify(quarantined)).not.toContain('private')
    expect(JSON.stringify(quarantined)).not.toContain('do-not-leak')
  })

  it('reconciles existing dead letters idempotently on worker startup', async () => {
    const envelope = {
      schemaVersion: '1.0.0',
      jobType: MEDIA_INGEST_QUEUE,
      captureSessionId: '10000000-0000-4000-8000-000000000011',
      candidate: 'match/main/short-tail.mp4',
      sourceOrder: '2',
      epochCandidateId: '10000000-0000-4000-8000-000000000012',
      sourceRestart: false,
      timestampDiscontinuity: false,
      explicitGapBeforeUs: null,
    } satisfies MediaIngestEnvelope
    const recorded: Record<string, unknown>[] = []
    const boss = {
      findJobs: async () => [
        {
          data: {
            ...envelope,
            permanentFailure: { code: 'PERMANENT_FAILURE' },
            sourceJobId: envelope.epochCandidateId,
            sourceQueue: MEDIA_INGEST_QUEUE,
          },
        },
        { data: { token: 'not-an-envelope' } },
      ],
    } as unknown as Pick<PgBoss, 'findJobs'>

    await expect(
      reconcilePermanentMediaFailures(boss, `${MEDIA_INGEST_QUEUE}.dead-letter`, async failure => {
        recorded.push(failure)
      }),
    ).resolves.toBe(1)
    expect(recorded).toEqual([
      {
        captureSessionId: envelope.captureSessionId,
        code: 'PERMANENT_FAILURE',
        sourceJobId: envelope.epochCandidateId,
      },
    ])
  })
})

describe('media ingest capture groups', () => {
  it('cancels queued successors for permanently failed capture keys', async () => {
    const cancelled: string[][] = []
    const boss = {
      getBlockedKeys: async () => ['capture-a', 'capture-b'],
      findJobs: async (_name: string, options: { key?: string }) =>
        options.key === 'capture-a' ? [{ id: 'job-a-2' }, { id: 'job-a-3' }] : [],
      cancel: async (_name: string, ids: string | string[]) => {
        cancelled.push(Array.isArray(ids) ? ids : [ids])
        return {}
      },
    } as unknown as Pick<PgBoss, 'cancel' | 'findJobs' | 'getBlockedKeys'>

    await expect(quarantineBlockedCaptureJobs(boss)).resolves.toBe(2)
    expect(cancelled).toEqual([['job-a-2', 'job-a-3']])
  })

  it('backfills each queued capture once for per-capture concurrency', async () => {
    const updates: string[] = []
    const boss = {
      findJobs: async () => [
        { singletonKey: 'capture-a', groupId: null },
        { singletonKey: 'capture-a', groupId: null },
        { singletonKey: 'capture-b', groupId: 'capture-b' },
        { singletonKey: 'capture-c', groupId: null },
      ],
      update: async (
        _name: string,
        _data: unknown,
        options: {
          singletonKey: string
        },
      ) => {
        updates.push(options.singletonKey)
        return { jobs: [options.singletonKey], updated: 1 }
      },
    } as unknown as Pick<PgBoss, 'findJobs' | 'update'>

    await expect(assignQueuedIngestGroups(boss)).resolves.toBe(2)
    expect(updates).toEqual(['capture-a', 'capture-c'])
  })
})
