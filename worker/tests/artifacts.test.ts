import { describe, expect, it } from 'vitest'
import {
  buildArtifactPlan,
  idempotencyKey,
  planObjectLocation,
  sha256,
  sourceContentSha256,
  validateBucketName,
} from '../src/media/artifacts'
import type { FinalizedRecording } from '../src/media/finalized-recording'
import type { SampleIndex } from '../src/media/sample-index'

const recording: FinalizedRecording = {
  captureSessionId: 'capture-session-01',
  trustedPath: 'H:\\spool\\private\\round-01\\segment-0001.m4s',
  sourceIdentity: 'private/round-01/segment-0001.m4s',
  byteLength: 9_007_199_254_740_993n,
  mtimeNs: 1_723_000_000_123_456_789n,
  finalized: true,
}

const sampleIndex: SampleIndex = {
  version: '1',
  epochId: 'epoch-01',
  timeBase: { num: 1n, den: 90_000n },
  samples: [
    {
      sourcePts: 9_007_199_254_740_993n,
      durationPts: 1_501n,
      captureTimeUs: 8_007_199_254_740_993n,
      captureFrameIndex: 9_107_199_254_740_993n,
      keyframe: true,
    },
  ],
  availableStartUs: 8_007_199_254_740_993n,
  availableEndUs: 8_007_199_254_757_671n,
}

const source = {
  initBytes: Uint8Array.from([0, 1, 2, 3]),
  mediaBytes: Uint8Array.from([4, 5, 6, 7, 8]),
}

describe('media artifact planning', () => {
  it('builds deterministic opaque locations without leaking bucket or source paths', () => {
    const first = buildArtifactPlan('volleyball-dvr', recording, source, sampleIndex)
    const second = buildArtifactPlan('volleyball-dvr', recording, source, sampleIndex)

    expect(second).toEqual(first)
    expect(first.idempotencyKey).toBe(
      'cab8909dd4148c5d8bd7c28c63c9d66e8acccaabd268e1cc8db60ea49dad4141',
    )
    expect(first.sourceIdentityHash).toBe(
      'e4eb3fd0397a4b8d8b7588f7683dd34942b58b2323bd39f7fa1c018d13d12c0e',
    )
    expect(first.sourceContentSha256).toBe(
      '8123de70879203ccb636ab102d8a3ad1a73302ad0b48400edbd6d25930405eeb',
    )
    expect(first.artifacts.map((artifact) => artifact.location.key)).toEqual([
      `dvr/capture-session-01/${first.idempotencyKey}/init.mp4`,
      `dvr/capture-session-01/${first.idempotencyKey}/media.mp4`,
      `dvr/capture-session-01/${first.idempotencyKey}/sample-index.json`,
    ])

    for (const artifact of first.artifacts) {
      expect(artifact.location.bucket).toBe('volleyball-dvr')
      expect(artifact.location.key).not.toContain('volleyball-dvr')
      expect(artifact.location.key).not.toContain('private')
      expect(artifact.location.key).not.toContain('segment-0001')
      expect(artifact.location.key).not.toContain('H:')
      expect(artifact.location.key).not.toContain('..')
      expect(artifact.location.key).not.toContain('\\')
    }
  })

  it('constructs exactly init, media, and serialized sample-index artifacts', () => {
    const plan = buildArtifactPlan('volleyball-dvr', recording, source, sampleIndex)

    expect(plan.artifacts).toHaveLength(3)
    expect(plan.artifacts.map((artifact) => artifact.kind)).toEqual([
      'init',
      'media',
      'sample-index',
    ])
    expect(
      plan.artifacts.map(
        ({ kind, byteLength, contentType, internalSchemaVersion }) => ({
          kind,
          byteLength,
          contentType,
          internalSchemaVersion,
        }),
      ),
    ).toEqual([
      {
        kind: 'init',
        byteLength: 4n,
        contentType: 'video/mp4',
        internalSchemaVersion: '1.0.0',
      },
      {
        kind: 'media',
        byteLength: 5n,
        contentType: 'video/mp4',
        internalSchemaVersion: '1.0.0',
      },
      {
        kind: 'sample-index',
        byteLength: BigInt(plan.artifacts[2].bytes.byteLength),
        contentType: 'application/json',
        internalSchemaVersion: '1.0.0',
      },
    ])

    for (const artifact of plan.artifacts) {
      expect(artifact.byteLength).toBeGreaterThan(0n)
      expect(artifact.sha256).toBe(sha256(artifact.bytes))
    }
    expect(plan.artifacts.map((artifact) => artifact.sha256)).toEqual([
      '054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8',
      '015daf6013376b77421b7fb9d5654d844c8cba4f7a5326d829426d87fd0d1a5f',
      '7dd623e7d21584d62d4776faef8fde83bfc40e219053b665c9d4a2d0ac24ee91',
    ])
    expect(
      JSON.parse(Buffer.from(plan.artifacts[2].bytes).toString('utf8')),
    ).toEqual(plan.sampleIndex)
    expect(plan.sampleIndex.schemaVersion).toBe('1.0.0')
  })

  it('uses all canonical recording fields and source content in idempotency', () => {
    const checksum = sourceContentSha256(source)
    const baseline = idempotencyKey(recording, checksum)
    const variants: FinalizedRecording[] = [
      { ...recording, captureSessionId: 'capture-session-02' },
      { ...recording, sourceIdentity: 'private/round-02/segment-0001.m4s' },
      { ...recording, byteLength: recording.byteLength + 1n },
      { ...recording, mtimeNs: recording.mtimeNs + 1n },
    ]

    expect(new Set(variants.map((value) => idempotencyKey(value, checksum))).size)
      .toBe(variants.length)
    expect(
      idempotencyKey(
        recording,
        sourceContentSha256({ ...source, mediaBytes: Uint8Array.of(9) }),
      ),
    ).not.toBe(baseline)
  })

  it.each([
    '',
    'UPPERCASE',
    'ab',
    'bucket/name',
    'bucket..name',
    'bucket.-name',
    '127.0.0.1',
  ])('rejects invalid bucket %j separately', (bucket) => {
    expect(() => validateBucketName(bucket)).toThrow('invalid DVR bucket')
  })

  it('rejects unsafe capture IDs and non-digest source locations', () => {
    expect(() =>
      planObjectLocation('volleyball-dvr', '../capture', 'a'.repeat(64), 'init'),
    ).toThrow('invalid capture session id')
    expect(() =>
      planObjectLocation('volleyball-dvr', 'capture-01', 'raw/source', 'init'),
    ).toThrow('invalid hashed source')
  })
})
