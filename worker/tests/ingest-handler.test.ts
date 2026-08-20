import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSampleIndex,
  serializeSampleIndex,
  type FfprobeFrame,
} from '@volleyball-monitoring/media'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ingestEnvelope,
  probeSamples,
  projectPlaybackFragmentRanges,
  projectPlaybackFragments,
  type HandlerDeps,
} from '../src/media/ingest-handler.js'
import { createEnvelope } from '../src/media/indexer-runtime.js'
import type {
  FinalizedSegmentReservation,
  FinalizedSegmentReservationInput,
  IngestReservationReference,
  PublishReadyInput,
} from '../src/media/prisma-ingest-repository.js'

const captureSessionId = '10000000-0000-4000-8000-000000000001'
const dvrProgramId = '10000000-0000-4000-8000-000000000002'
const dvrSegmentId = '10000000-0000-4000-8000-000000000003'
const sampleIndexAssetId = '10000000-0000-4000-8000-000000000004'
const temporaryPaths: string[] = []

it('derives quantized RTMP durations from adjacent PTS', () => {
  const frames = [1890, 4860, 7920, 10890].map(pts => ({
    media_type: 'video' as const,
    pts: String(pts),
    pkt_duration: '3000',
    key_frame: 1,
  }))
  expect(probeSamples(frames).map(sample => sample.durationPts)).toEqual([
    2970n,
    3060n,
    2970n,
    3000n,
  ])
})

it('projects short fMP4 byte ranges onto keyframe-aligned durations', () => {
  const samples = probeSamples(
    [
      { media_type: 'video', pts: '0', pkt_duration: '1', key_frame: 1 },
      { media_type: 'video', pts: '1', pkt_duration: '1', key_frame: 0 },
      { media_type: 'video', pts: '2', pkt_duration: '1', key_frame: 1 },
      { media_type: 'video', pts: '3', pkt_duration: '1', key_frame: 0 },
    ],
    4n,
  )
  expect(
    projectPlaybackFragments(
      {
        initBytes: Buffer.from('init'),
        mediaBytes: Buffer.alloc(1_200),
        mediaFragments: [
          { byteOffset: 100n, byteLength: 500n },
          { byteOffset: 600n, byteLength: 600n },
        ],
      },
      samples,
      { num: 1n, den: 1_000n },
    ),
  ).toEqual([
    { byteOffset: 100n, byteLength: 500n, durationUs: 2_000n },
    { byteOffset: 600n, byteLength: 600n, durationUs: 2_000n },
  ])
})
it('folds a contiguous trailing audio fragment into the final video GOP', () => {
  expect(
    projectPlaybackFragmentRanges(
      [
        { byteOffset: 0n, byteLength: 100n },
        { byteOffset: 100n, byteLength: 120n },
        { byteOffset: 220n, byteLength: 8n },
      ],
      228n,
      [
        { sourcePts: 0n, durationPts: 1n, keyframe: true },
        { sourcePts: 1n, durationPts: 1n, keyframe: false },
        { sourcePts: 2n, durationPts: 1n, keyframe: true },
        { sourcePts: 3n, durationPts: 1n, keyframe: false },
      ],
      { num: 1n, den: 1n },
    ),
  ).toEqual([
    { byteOffset: 0n, byteLength: 100n, durationUs: 2_000_000n },
    { byteOffset: 100n, byteLength: 128n, durationUs: 2_000_000n },
  ])
})
it('rejects malformed adjacent PTS before deriving duration', () => {
  expect(() =>
    probeSamples([
      { media_type: 'video', pts: '1890', pkt_duration: '3000' },
      { media_type: 'video', pkt_duration: '3000' },
    ]),
  ).toThrow()
})
it('rejects malformed final packet duration deterministically', () => {
  expect(() =>
    probeSamples([{ media_type: 'video', pts: '1890', pkt_duration: 'not-a-duration' }]),
  ).toThrow('Finalized media sample timing is invalid.')
})
it('derives a missing finalized fMP4 tail duration from the video stream end', () => {
  expect(
    probeSamples(
      [
        { media_type: 'video', pts: '0', key_frame: 1 },
        { media_type: 'video', pts: '1500', key_frame: 0 },
      ],
      3003n,
    ),
  ).toEqual([
    { sourcePts: 0n, durationPts: 1500n, keyframe: true },
    { sourcePts: 1500n, durationPts: 1503n, keyframe: false },
  ])
})
it('fails closed when packet duration conflicts with the video stream end', () => {
  expect(() =>
    probeSamples([{ media_type: 'video', pts: '0', pkt_duration: '1000', key_frame: 1 }], 1001n),
  ).toThrow('Finalized media sample timing is invalid.')
})

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map(path => rm(path, { force: true, recursive: true })),
  )
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
    const publishInputs: PublishReadyInput[] = []
    const locations: string[][] = []
    const index = authoritativeIndex(envelope.epochCandidateId)
    const reference = (input: FinalizedSegmentReservationInput): IngestReservationReference => ({
      captureSessionId,
      dvrProgramId,
      dvrSegmentId,
      sampleIndexAssetId,
      sampleIndexLocation: input.artifacts.find(artifact => artifact.kind === 'sample-index')!
        .location,
    })
    const repository = {
      async reserveUploading(input: FinalizedSegmentReservationInput) {
        events.push('reserve')
        reservationInputs.push(input)
        locations.push(input.artifacts.map(artifact => artifact.location.key))
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
      async publishReady(input: PublishReadyInput) {
        events.push('publish')
        publishInputs.push(input)
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
        async upload(artifact) {
          events.push(`upload:${artifact.kind}`)
        },
        async verify(artifact) {
          events.push(`verify:${artifact.kind}`)
        },
      },
    } satisfies HandlerDeps

    await ingestEnvelope(envelope, deps)
    await ingestEnvelope(envelope, deps)

    expect(reservationInputs).toHaveLength(2)
    expect(reservationInputs[0]!.samples).toEqual([
      { sourcePts: -2n, durationPts: 2n, keyframe: true },
      { sourcePts: 0n, durationPts: 3n, keyframe: false },
    ])
    expect(reservationInputs[0]!.idempotencyKey).toBe(reservationInputs[1]!.idempotencyKey)
    expect(locations[0]).toEqual(locations[1])
    expect(publishInputs).toHaveLength(2)
    for (const input of publishInputs) {
      expect(input.extent).toMatchObject({
        sourceJobId: envelope.epochCandidateId,
        localPath: envelope.candidate,
      })
      expect(input.extent?.finalizedAt).toBeInstanceOf(Date)
      expect(Number.isNaN(input.extent!.finalizedAt.getTime())).toBe(false)
    }
    expect(publishInputs[0]!.extent!.finalizedAt).toEqual(publishInputs[1]!.extent!.finalizedAt)
    expect(events).toEqual([
      'source',
      'profile',
      'reserve',
      'expectations',
      'upload:init',
      'upload:media',
      'upload:sample-index',
      'verify:init',
      'verify:media',
      'verify:sample-index',
      'publish',
      'source',
      'profile',
      'reserve',
      'expectations',
      'upload:init',
      'upload:media',
      'upload:sample-index',
      'verify:init',
      'verify:media',
      'verify:sample-index',
      'publish',
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
        async recordArtifactExpectations() {
          throw new Error('must not record')
        },
        async publishReady() {
          throw new Error('must not publish')
        },
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
        async upload() {
          throw new Error('must not upload')
        },
        async verify() {
          throw new Error('must not verify')
        },
      },
    } as unknown as HandlerDeps

    await expect(ingestEnvelope(envelope, deps)).rejects.toThrow('sample timing is invalid')
    expect(reserved).toBe(false)
    expect(readSource).toBe(false)
  })
})
