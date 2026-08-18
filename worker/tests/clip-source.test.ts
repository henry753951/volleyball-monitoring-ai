import type { PrismaClient } from '@volleyball-monitoring/db'
import { describe, expect, it, vi } from 'vitest'
import { resolveClipSources } from '../src/media/clip-source.js'

const digest = (kind: 'init' | 'media' | 'index') =>
  ({ init: 'a', media: 'b', index: 'c' })[kind].repeat(64)
const epoch = {
  id: 'epoch-1',
  captureSessionId: 'session-1',
  sourcePtsOrigin: 0n,
  captureTimeOriginUs: 0n,
  captureFrameOrigin: 0n,
  sourceTimeBaseNum: 1,
  sourceTimeBaseDen: 90_000,
}
const asset = (kind: 'init' | 'media' | 'index', sequence: number) => ({
  bucket: 'media',
  objectKey: `${kind}/${sequence}`,
  byteLength: 100n + BigInt(sequence),
  sha256: digest(kind),
  internalSchemaVersion: '1.0.0',
})
const legacy = (sequence: number, discontinuitySequence = 0) => ({
  id: `segment-${sequence}`,
  captureEpochId: epoch.id,
  sequenceNumber: BigInt(sequence),
  discontinuitySequence,
  captureStartUs: BigInt(sequence * 10_000_000),
  captureEndUs: BigInt((sequence + 1) * 10_000_000),
  sourcePtsStart: BigInt(sequence * 900_000),
  sourcePtsEnd: BigInt((sequence + 1) * 900_000),
  firstFrameIndex: BigInt(sequence * 300),
  frameCount: 300n,
  captureEpoch: epoch,
  initAsset: asset('init', sequence),
  mediaAsset: asset('media', sequence),
  sampleIndexAsset: asset('index', sequence),
})
const extent = (sequence: number, discontinuitySequence = 0) => {
  const segment = legacy(sequence, discontinuitySequence)
  return {
    id: `extent-${sequence}`,
    captureSessionId: epoch.captureSessionId,
    dvrProgramId: 'program-1',
    dvrSegmentId: segment.id,
    captureEpochId: epoch.id,
    sequenceNumber: segment.sequenceNumber,
    discontinuitySequence,
    startUs: segment.captureStartUs,
    endUs: segment.captureEndUs,
    sourcePtsStart: segment.sourcePtsStart,
    sourcePtsEnd: segment.sourcePtsEnd,
    firstFrameIndex: segment.firstFrameIndex,
    frameCount: segment.frameCount,
    bucket: segment.mediaAsset.bucket,
    objectKey: segment.mediaAsset.objectKey,
    bytes: segment.mediaAsset.byteLength,
    mediaSha256: segment.mediaAsset.sha256,
    mediaSchemaVersion: segment.mediaAsset.internalSchemaVersion,
    initBucket: segment.initAsset.bucket,
    initObjectKey: segment.initAsset.objectKey,
    initBytes: segment.initAsset.byteLength,
    initSha256: segment.initAsset.sha256,
    initSchemaVersion: segment.initAsset.internalSchemaVersion,
    sampleIndexBucket: segment.sampleIndexAsset.bucket,
    sampleIndexObjectKey: segment.sampleIndexAsset.objectKey,
    sampleIndexBytes: segment.sampleIndexAsset.byteLength,
    sampleIndexSha256: segment.sampleIndexAsset.sha256,
    sampleIndexSchemaVersion: segment.sampleIndexAsset.internalSchemaVersion,
    archiveVerifiedAt: new Date('2026-08-18T00:00:00Z'),
    captureEpoch: epoch,
  }
}
const database = (extents: unknown[], segments: unknown[]) =>
  ({
    mediaExtent: { findMany: vi.fn().mockResolvedValue(extents) },
    dvrSegment: { findMany: vi.fn().mockResolvedValue(segments) },
  }) as unknown as PrismaClient
const input = {
  dvrProgramId: 'program-1',
  captureSessionId: epoch.captureSessionId,
  requestedStartCaptureUs: 0n,
  requestedEndCaptureUs: 20_000_000n,
  anchorCaptureTimeUs: 5_000_000n,
}

describe('resolveClipSources', () => {
  it('prefers exact extent parity without crossing a zero-gap discontinuity', async () => {
    const sources = await resolveClipSources(
      database([extent(0), extent(1, 1)], [legacy(0), legacy(1, 1)]),
      { ...input, requestedEndCaptureUs: 10_000_000n },
    )
    expect(sources.map(source => source.id)).toEqual(['extent-0'])
  })

  it('uses the complete legacy run when an edge extent is missing', async () => {
    const sources = await resolveClipSources(database([extent(1)], [legacy(0), legacy(1)]), input)
    expect(sources.map(source => source.id)).toEqual(['segment-0', 'segment-1'])
  })

  it('fails closed for a complete but invalid extent projection', async () => {
    await expect(
      resolveClipSources(database([{ ...extent(0), mediaSchemaVersion: '2.0.0' }], [legacy(0)]), {
        ...input,
        requestedEndCaptureUs: 10_000_000n,
      }),
    ).rejects.toThrow('media extent projection is invalid')
  })
})
