import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSampleIndex,
  serializeSampleIndex,
  type FfprobeFrame,
} from '@volleyball-monitoring/media'
import { afterEach, describe, expect, it } from 'vitest'
import { ingestEnvelope, type HandlerDeps } from '../src/media/ingest-handler.js'
import { createEnvelope } from '../src/media/indexer-runtime.js'
import type {
  FinalizedSegmentReservation,
  FinalizedSegmentReservationInput,
  IngestReservationReference,
} from '../src/media/prisma-ingest-repository.js'

const captureSessionId = '10000000-0000-4000-8000-000000000001'
const dvrProgramId = '10000000-0000-4000-8000-000000000002'
const dvrSegmentId = '10000000-0000-4000-8000-000000000003'
const sampleIndexAssetId = '10000000-0000-4000-8000-000000000004'
const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) =>
    rm(path, { force: true, recursive: true })))
})

async function fixture() {
  const spoolRoot = await mkdtemp(join(tmpdir(), 'volleyball-handler-'))
  temporaryPaths.push(spoolRoot)
  await mkdir(join(spoolRoot, 'court-a'))
  const candidate = 'court-a/2026-08-07_06-30-01-123456.mp4'
  await writeFile(join(spoolRoot, ...candidate.split('/')), Buffer.from('source'))
  return {
    spoolRoot,
    envelope: createEnvelope({
      schemaVersion: '1.0.0',
      jobType: 'media.ingest.finalized.v1',
      captureSessionId,
      candidate,
      sourceOrder: '1786084201123456',
      sourceRestart: false,
      timestampDiscontinuity: false,
      explicitGapBeforeUs: null,
    }),
  }
}

const frames: FfprobeFrame[] = [
  { media_type: 'video', pts: '-2', pkt_duration: '2', key_frame: 1 },
  { media_type: 'video', pts: '0', pkt_duration: '3', key_frame: 0 },
]

function authoritativeIndex(epochId: string) {
  return buildSampleIndex(frames, {
    epochId,
    sourcePtsOrigin: -2n,
    captureTimeOriginUs: 9_007_199_254_740_993n,
    captureFrameOrigin: 9_107_199_254_740_993n,
    timeBase: { num: 1n, den: 1_000n },
  })
}

describe('repository-native finalized ingest handler', () => {
  it('uses repository authority and preserves reserve/verify/publish order on replay', async () => {
    const { spoolRoot, envelope } = await fixture()
    const events: string[] = []
    const reservationInputs: FinalizedSegmentReservationInput[] = []
    const locations: string[][] = []
    const index = authoritativeIndex(envelope.epochCandidateId)
    const reference = (input: FinalizedSegmentReservationInput): IngestReservationReference => ({
      captureSessionId,
      dvrProgramId,
      dvrSegmentId,
      sampleIndexAssetId,
      sampleIndexLocation: input.artifacts.find(
        (artifact) => artifact.kind === 'sample-index',
      )!.location,
    })
    const repository = {
      async reserveUploading(input: FinalizedSegmentReservationInput) {
        events.push('reserve')
        reservationInputs.push(input)
        locations.push(input.artifacts.map((artifact) => artifact.location.key))
        return {
          disposition: reservationInputs.length === 1 ? 'RESERVED' : 'ALREADY_READY',
          reference: reference(input),
          sampleIndex: index,
        } as unknown as FinalizedSegmentReservation
      },
      async recordArtifactExpectations(input: {
        sampleIndexDocument: ReturnType<typeof serializeSampleIndex>
      }) {
        events.push('expectations')
        expect(input.sampleIndexDocument).toEqual(serializeSampleIndex(index))
      },
      async publishReady() {
        events.push('publish')
        return {
          disposition: 'PUBLISHED' as const,
          readyAt: new Date('2026-08-07T06:30:00.000Z'),
          playlistRevision: 1n,
        }
      },
    }
    const deps = {
      spoolRoot,
      bucket: 'dvr-media',
      repository,
      probe: async () => ({ frames, timeBase: { num: 1n, den: 1_000n } }),
      source: {
        async read() {
          events.push('source')
          return {
            initBytes: Buffer.from('init'),
            mediaBytes: Buffer.from('media'),
          }
        },
      },
      profile: async () => {
        events.push('profile')
        return { fpsNum: 400, fpsDen: 1, timeBaseNum: 1, timeBaseDen: 1_000 }
      },
      store: {
        async upload(artifact) { events.push(`upload:${artifact.kind}`) },
        async verify(artifact) { events.push(`verify:${artifact.kind}`) },
      },
    } satisfies HandlerDeps

    await ingestEnvelope(envelope, deps)
    await ingestEnvelope(envelope, deps)

    expect(reservationInputs).toHaveLength(2)
    expect(reservationInputs[0]!.samples).toEqual([
      { sourcePts: -2n, durationPts: 2n, keyframe: true },
      { sourcePts: 0n, durationPts: 3n, keyframe: false },
    ])
    expect(reservationInputs[0]!.idempotencyKey).toBe(
      reservationInputs[1]!.idempotencyKey,
    )
    expect(locations[0]).toEqual(locations[1])
    expect(events).toEqual([
      'source', 'profile', 'reserve', 'expectations',
      'upload:init', 'upload:media', 'upload:sample-index',
      'verify:init', 'verify:media', 'verify:sample-index', 'publish',
      'source', 'profile', 'reserve', 'expectations',
      'upload:init', 'upload:media', 'upload:sample-index',
      'verify:init', 'verify:media', 'verify:sample-index', 'publish',
    ])
  })

  it('rejects missing probe timing before reserving or uploading', async () => {
    const { spoolRoot, envelope } = await fixture()
    let reserved = false
    let readSource = false
    const deps = {
      spoolRoot,
      bucket: 'dvr-media',
      repository: {
        async reserveUploading() {
          reserved = true
          throw new Error('must not reserve')
        },
        async recordArtifactExpectations() { throw new Error('must not record') },
        async publishReady() { throw new Error('must not publish') },
      },
      probe: async () => ({
        frames: [{ media_type: 'video', pkt_duration: '2', key_frame: 1 }],
        timeBase: { num: 1n, den: 1_000n },
      }),
      source: {
        async read() {
          readSource = true
          return { initBytes: Buffer.from('init'), mediaBytes: Buffer.from('media') }
        },
      },
      profile: async () => ({
        fpsNum: 30,
        fpsDen: 1,
        timeBaseNum: 1,
        timeBaseDen: 1_000,
      }),
      store: {
        async upload() { throw new Error('must not upload') },
        async verify() { throw new Error('must not verify') },
      },
    } as unknown as HandlerDeps

    await expect(ingestEnvelope(envelope, deps)).rejects.toThrow(
      'sample timing is invalid',
    )
    expect(reserved).toBe(false)
    expect(readSource).toBe(false)
  })
})
