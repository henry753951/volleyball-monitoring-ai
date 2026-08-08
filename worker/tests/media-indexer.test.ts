import { describe, expect, it } from 'vitest'
import {
  assignQueuedIngestGroups,
  MEDIA_INGEST_QUEUE,
  quarantinePermanentMediaFailures,
  type MediaIngestEnvelope,
} from '../src/roles/media-indexer.js'
import type { PgBoss } from 'pg-boss'

describe('media ingest failure quarantine', () => {
  it('keeps the audit copy without leaving a strict FIFO poison job', async () => {
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

    const results = await quarantinePermanentMediaFailures(
      [{ id: envelope.epochCandidateId, data: envelope }],
      [{
        id: envelope.epochCandidateId,
        status: 'deadletter',
        output: { code: 'PERMANENT_FAILURE' },
      }],
      async (_id, data) => {
        quarantined.push(data)
      },
    )

    expect(results).toEqual([{
      id: envelope.epochCandidateId,
      status: 'completed',
      output: { code: 'PERMANENT_FAILURE' },
    }])
    expect(quarantined).toEqual([expect.objectContaining({
      captureSessionId: envelope.captureSessionId,
      permanentFailure: { code: 'PERMANENT_FAILURE' },
      sourceJobId: envelope.epochCandidateId,
      sourceQueue: MEDIA_INGEST_QUEUE,
    })])
  })
})

describe('media ingest capture groups', () => {
  it('backfills each queued capture once for per-capture concurrency', async () => {
    const updates: string[] = []
    const boss = {
      findJobs: async () => [
        { singletonKey: 'capture-a', groupId: null },
        { singletonKey: 'capture-a', groupId: null },
        { singletonKey: 'capture-b', groupId: 'capture-b' },
        { singletonKey: 'capture-c', groupId: null },
      ],
      update: async (_name: string, _data: unknown, options: {
        singletonKey: string
      }) => {
        updates.push(options.singletonKey)
        return { jobs: [options.singletonKey], updated: 1 }
      },
    } as unknown as Pick<PgBoss, 'findJobs' | 'update'>

    await expect(assignQueuedIngestGroups(boss)).resolves.toBe(2)
    expect(updates).toEqual(['capture-a', 'capture-c'])
  })
})
