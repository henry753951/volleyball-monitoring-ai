import { describe, expect, it } from 'vitest'
import {
  ingestFinalizedSegment,
  type ArtifactSource,
  type IngestClaim,
  type MediaIngestRepository,
  type MediaObjectStore,
  type ReadyTransaction,
  type RetryableFailure,
  type UploadingRecord,
} from '../src/media/ingest'
import type { ArtifactKind, ArtifactMetadata, MediaArtifact } from '../src/media/artifacts'
import type { FinalizedRecording } from '../src/media/finalized-recording'
import type { SampleIndex } from '../src/media/sample-index'

const recording: FinalizedRecording = {
  captureSessionId: 'capture-01',
  trustedPath: 'H:\\trusted-spool\\private\\segment-01.m4s',
  sourceIdentity: 'private/segment-01.m4s',
  byteLength: 1_024n,
  mtimeNs: 1_723_000_000_123_456_789n,
  finalized: true,
}

const sampleIndex: SampleIndex = {
  epochId: 'epoch-01',
  timeBase: { num: 1n, den: 30n },
  samples: [
    {
      sourcePts: 9_007_199_254_740_993n,
      durationPts: 1n,
      captureTimeUs: 8_007_199_254_740_993n,
      captureFrameIndex: 9_107_199_254_740_993n,
      keyframe: true,
    },
  ],
  availableStartUs: 8_007_199_254_740_993n,
  availableEndUs: 8_007_199_254_774_326n,
}

const sourceBytes = {
  initBytes: Uint8Array.of(1, 2, 3),
  mediaBytes: Uint8Array.of(4, 5, 6, 7),
}

type HarnessOptions = {
  claims?: IngestClaim[]
  failSource?: boolean
  failClaim?: boolean
  failRecordUploading?: boolean
  failUpload?: ArtifactKind
  failVerify?: ArtifactKind
  failPublish?: boolean
}

class FakeArtifactSource implements ArtifactSource {
  calls = 0

  constructor(
    private readonly order: string[],
    private readonly fail: boolean,
  ) {}

  async read(value: FinalizedRecording) {
    this.calls += 1
    this.order.push('artifact-source')
    expect(value.trustedPath).toBe(recording.trustedPath)
    if (this.fail) throw new Error('artifact source unavailable')
    return sourceBytes
  }
}

class FakeRepository implements MediaIngestRepository {
  readonly claimKeys: string[] = []
  readonly uploadingRecords: UploadingRecord[] = []
  readonly readyTransactions: ReadyTransaction[] = []
  readonly failures: RetryableFailure[] = []
  readyPublished = false

  constructor(
    private readonly order: string[],
    private readonly options: HarnessOptions,
  ) {}

  async claim(idempotencyKey: string): Promise<IngestClaim> {
    this.order.push('claim')
    this.claimKeys.push(idempotencyKey)
    if (this.options.failClaim) throw new Error('claim database unavailable')
    return this.options.claims?.shift() ?? 'CLAIMED'
  }

  async recordUploading(record: UploadingRecord): Promise<void> {
    this.order.push('record-uploading')
    this.uploadingRecords.push(record)
    if (this.options.failRecordUploading) {
      throw new Error('uploading metadata unavailable')
    }
  }

  async publishReadyTransaction(transaction: ReadyTransaction): Promise<void> {
    this.order.push('publish-ready')
    this.readyTransactions.push(transaction)
    if (this.options.failPublish) throw new Error('ready transaction failed')
    this.readyPublished = true
  }

  async markRetryableFailure(failure: RetryableFailure): Promise<void> {
    this.order.push('mark-retryable')
    this.failures.push(failure)
  }
}

class FakeObjectStore implements MediaObjectStore {
  readonly uploads: MediaArtifact[] = []
  readonly verifications: ArtifactMetadata[] = []

  constructor(
    private readonly order: string[],
    private readonly options: HarnessOptions,
  ) {}

  async upload(artifact: MediaArtifact): Promise<void> {
    this.order.push(`upload:${artifact.kind}`)
    this.uploads.push(artifact)
    if (this.options.failUpload === artifact.kind) {
      throw new Error(`upload ${artifact.kind} failed`)
    }
  }

  async verify(artifact: ArtifactMetadata): Promise<void> {
    this.order.push(`verify:${artifact.kind}`)
    this.verifications.push(artifact)
    if (this.options.failVerify === artifact.kind) {
      throw new Error(`verify ${artifact.kind} failed`)
    }
  }
}

function createHarness(options: HarnessOptions = {}) {
  const order: string[] = []
  const artifactSource = new FakeArtifactSource(order, options.failSource ?? false)
  const repository = new FakeRepository(order, options)
  const store = new FakeObjectStore(order, options)
  return {
    order,
    artifactSource,
    repository,
    store,
    ports: {
      bucket: 'volleyball-dvr',
      artifactSource,
      repository,
      store,
    },
  }
}

describe('ingestFinalizedSegment', () => {
  it('records, uploads, verifies, and publishes exactly three artifacts in order', async () => {
    const harness = createHarness()

    await expect(ingestFinalizedSegment(recording, harness.ports, sampleIndex)).resolves.toBe(
      'published',
    )

    expect(harness.order).toEqual([
      'artifact-source',
      'claim',
      'record-uploading',
      'upload:init',
      'upload:media',
      'upload:sample-index',
      'verify:init',
      'verify:media',
      'verify:sample-index',
      'publish-ready',
    ])
    expect(harness.store.uploads).toHaveLength(3)
    expect(harness.store.verifications).toHaveLength(3)
    expect(harness.repository.uploadingRecords).toHaveLength(1)
    expect(harness.repository.readyTransactions).toHaveLength(1)
    expect(harness.repository.failures).toHaveLength(0)
    expect(harness.repository.readyPublished).toBe(true)

    const uploading = harness.repository.uploadingRecords[0]!
    expect(uploading.idempotencyKey).toBe(harness.repository.claimKeys[0])
    expect(uploading.sourceIdentityHash).toMatch(/^[a-f0-9]{64}$/)
    expect(uploading.sourceContentSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(uploading).not.toHaveProperty('trustedPath')
    expect(uploading).not.toHaveProperty('sourceIdentity')
    expect(uploading.artifacts).toEqual(harness.store.verifications)
    expect(uploading.artifacts.every(artifact => !('bytes' in artifact))).toBe(true)

    const transaction = harness.repository.readyTransactions[0]!
    expect(transaction.artifacts).toEqual(uploading.artifacts)
    expect(transaction.sampleIndex.schemaVersion).toBe('1.0.0')
  })

  it.each([
    ['ALREADY_READY', 'already_ready'],
    ['LEASED', 'retry'],
  ] as const)('stops after a %s claim', async (claim, result) => {
    const harness = createHarness({ claims: [claim] })

    await expect(ingestFinalizedSegment(recording, harness.ports, sampleIndex)).resolves.toBe(
      result,
    )

    expect(harness.order).toEqual(['artifact-source', 'claim'])
    expect(harness.store.uploads).toHaveLength(0)
    expect(harness.store.verifications).toHaveLength(0)
    expect(harness.repository.uploadingRecords).toHaveLength(0)
    expect(harness.repository.readyTransactions).toHaveLength(0)
    expect(harness.repository.failures).toHaveLength(0)
  })

  it.each([
    [{ ...recording, finalized: false }, 'not finalized'],
    [{ ...recording, byteLength: 0n }, 'recording is empty'],
  ] as const)('rejects invalid finalized recording input', async (value, message) => {
    const harness = createHarness()

    await expect(ingestFinalizedSegment(value, harness.ports, sampleIndex)).rejects.toThrow(message)
    expect(harness.order).toEqual([])
  })

  it('records artifact-source evidence without claiming or publishing', async () => {
    const harness = createHarness({ failSource: true })

    await expect(ingestFinalizedSegment(recording, harness.ports, sampleIndex)).resolves.toBe(
      'retry',
    )

    expect(harness.order).toEqual(['artifact-source', 'mark-retryable'])
    expect(harness.repository.failures).toEqual([
      {
        idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        stage: 'ARTIFACT_SOURCE',
        code: 'ARTIFACT_SOURCE_FAILED',
        message: 'artifact source unavailable',
      },
    ])
    expect(harness.repository.readyPublished).toBe(false)
  })

  it('records empty artifact-source output as retryable evidence', async () => {
    const harness = createHarness()
    harness.ports.artifactSource = {
      read: async () => ({
        initBytes: new Uint8Array(),
        mediaBytes: sourceBytes.mediaBytes,
      }),
    }

    await expect(ingestFinalizedSegment(recording, harness.ports, sampleIndex)).resolves.toBe(
      'retry',
    )
    expect(harness.repository.failures[0]).toMatchObject({
      stage: 'ARTIFACT_SOURCE',
      code: 'ARTIFACT_SOURCE_FAILED',
      message: 'init artifact is empty',
    })
    expect(harness.repository.readyPublished).toBe(false)
  })

  it('records claim failure evidence', async () => {
    const harness = createHarness({ failClaim: true })

    await expect(ingestFinalizedSegment(recording, harness.ports, sampleIndex)).resolves.toBe(
      'retry',
    )
    expect(harness.repository.failures[0]).toMatchObject({
      stage: 'CLAIM',
      code: 'CLAIM_FAILED',
      message: 'claim database unavailable',
    })
    expect(harness.repository.readyPublished).toBe(false)
  })

  it('records uploading-metadata failure before object writes', async () => {
    const harness = createHarness({ failRecordUploading: true })

    await expect(ingestFinalizedSegment(recording, harness.ports, sampleIndex)).resolves.toBe(
      'retry',
    )
    expect(harness.repository.failures[0]).toMatchObject({
      stage: 'RECORD_UPLOADING',
      code: 'RECORD_UPLOADING_FAILED',
      message: 'uploading metadata unavailable',
    })
    expect(harness.store.uploads).toHaveLength(0)
    expect(harness.repository.readyPublished).toBe(false)
  })

  it.each([
    ['init', 'UPLOAD_INIT'],
    ['media', 'UPLOAD_MEDIA'],
    ['sample-index', 'UPLOAD_SAMPLE_INDEX'],
  ] as const)('records %s upload failure and never publishes ready', async (kind, stage) => {
    const harness = createHarness({ failUpload: kind })

    await expect(ingestFinalizedSegment(recording, harness.ports, sampleIndex)).resolves.toBe(
      'retry',
    )
    expect(harness.repository.failures[0]).toMatchObject({
      stage,
      code: 'UPLOAD_FAILED',
      message: `upload ${kind} failed`,
    })
    expect(harness.store.verifications).toHaveLength(0)
    expect(harness.repository.readyPublished).toBe(false)
  })

  it.each([
    ['init', 'VERIFY_INIT'],
    ['media', 'VERIFY_MEDIA'],
    ['sample-index', 'VERIFY_SAMPLE_INDEX'],
  ] as const)('records %s verification failure and never publishes ready', async (kind, stage) => {
    const harness = createHarness({ failVerify: kind })

    await expect(ingestFinalizedSegment(recording, harness.ports, sampleIndex)).resolves.toBe(
      'retry',
    )
    expect(harness.store.uploads).toHaveLength(3)
    expect(harness.repository.failures[0]).toMatchObject({
      stage,
      code: 'VERIFY_FAILED',
      message: `verify ${kind} failed`,
    })
    expect(harness.repository.readyPublished).toBe(false)
  })

  it('records publish failure without reporting ready', async () => {
    const harness = createHarness({ failPublish: true })

    await expect(ingestFinalizedSegment(recording, harness.ports, sampleIndex)).resolves.toBe(
      'retry',
    )
    expect(harness.repository.failures[0]).toMatchObject({
      stage: 'PUBLISH_READY',
      code: 'PUBLISH_FAILED',
      message: 'ready transaction failed',
    })
    expect(harness.repository.readyTransactions).toHaveLength(1)
    expect(harness.repository.readyPublished).toBe(false)
  })

  it('retries with the same digest and locations without duplicating ready state', async () => {
    const harness = createHarness({ claims: ['CLAIMED', 'ALREADY_READY'] })

    await expect(ingestFinalizedSegment(recording, harness.ports, sampleIndex)).resolves.toBe(
      'published',
    )
    await expect(ingestFinalizedSegment(recording, harness.ports, sampleIndex)).resolves.toBe(
      'already_ready',
    )

    expect(harness.repository.claimKeys).toHaveLength(2)
    expect(harness.repository.claimKeys[1]).toBe(harness.repository.claimKeys[0])
    expect(harness.artifactSource.calls).toBe(2)
    expect(harness.store.uploads).toHaveLength(3)
    expect(harness.repository.readyTransactions).toHaveLength(1)
  })

  it('keeps annotation, submission, clip, and AI methods out of ingest ports', () => {
    const harness = createHarness()
    const repositoryMethods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(harness.repository),
    ).filter(name => name !== 'constructor')
    const objectStoreMethods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(harness.store),
    ).filter(name => name !== 'constructor')

    expect(repositoryMethods).toEqual([
      'claim',
      'recordUploading',
      'publishReadyTransaction',
      'markRetryableFailure',
    ])
    expect(objectStoreMethods).toEqual(['upload', 'verify'])
  })
})
