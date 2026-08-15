import type { AnalysisData } from '@volleyball-monitoring/contracts'
import type { Prisma } from '@volleyball-monitoring/db/client'
import { describe, expect, it, vi } from 'vitest'
import {
  ProviderAnalysisMaterializationError,
  registerProviderAnalysisEvidence,
  type ProviderAnalysisOutputArtifact,
} from '../src/roles/provider-analysis-materializer.js'

const hash = (character: string) => character.repeat(64)

function artifact(kind: string, digest: string, id: string): ProviderAnalysisOutputArtifact {
  return {
    artifactKind: kind,
    schemaVersion: '1.0.0',
    sha256: digest,
    byteLength: 16n,
    contentType: 'application/octet-stream',
    mediaAsset: {
      id,
      bucket: 'analysis',
      objectKey: id,
      byteLength: 16n,
      sha256: digest,
    },
  }
}

function fixture() {
  const evidenceArtifact = artifact('ANALYSIS_EVIDENCE_MANIFEST', hash('a'), 'evidence-asset')
  const poseArtifact = artifact('PERSON_POSE_EVIDENCE_MANIFEST', hash('b'), 'pose-asset')
  const cropArtifact = artifact('PLAYER_CROP_SOURCE_MANIFEST', hash('c'), 'crop-asset')
  const firstChunk = artifact('PERSON_POSE_EVIDENCE_CHUNK', hash('d'), 'chunk-0')
  const secondChunk = artifact('PERSON_POSE_EVIDENCE_CHUNK', hash('e'), 'chunk-1')
  return {
    analysisRunId: 'analysis-run',
    analysisData: { totalFrames: 3n } as AnalysisData,
    evidence: {
      schema_version: '1.0.0',
      content_sha256: hash('f'),
    },
    evidenceArtifact,
    poseManifest: {
      schema_version: '1.0.0',
      content_sha256: hash('1'),
      canonical_frame_count: '3',
      player_observation_count: '3',
      pose_observation_count: '2',
      missing_observation_count: '1',
      pose_recipe: { namespace: 'pose/every-frame/v1' },
      chunks: [
        {
          index: 0,
          start_frame_index: '0',
          end_frame_index: '1',
          player_observation_count: '2',
          pose_observation_count: '1',
          missing_observation_count: '1',
          artifact: { kind: 'PERSON_POSE_EVIDENCE_CHUNK', sha256: firstChunk.sha256 },
        },
        {
          index: 1,
          start_frame_index: '2',
          end_frame_index: '2',
          player_observation_count: '1',
          pose_observation_count: '1',
          missing_observation_count: '0',
          artifact: { kind: 'PERSON_POSE_EVIDENCE_CHUNK', sha256: secondChunk.sha256 },
        },
      ],
    },
    poseArtifact,
    cropArtifact,
    artifacts: [evidenceArtifact, poseArtifact, cropArtifact, firstChunk, secondChunk],
  }
}

function transaction() {
  return {
    analysisEvidenceBundle: {
      create: vi.fn(async () => ({ id: 'bundle-id' })),
    },
    personPoseEvidenceManifest: {
      create: vi.fn(async () => ({ id: 'pose-manifest-id' })),
    },
    personPoseEvidenceChunk: {
      createMany: vi.fn(async () => ({ count: 2 })),
    },
  }
}

describe('provider analysis evidence materialization', () => {
  it('registers complete pose coverage and keeps the crop-source artifact addressable', async () => {
    const tx = transaction()
    await registerProviderAnalysisEvidence(tx as unknown as Prisma.TransactionClient, fixture())

    expect(tx.analysisEvidenceBundle.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        analysisRunId: 'analysis-run',
        manifestAssetId: 'evidence-asset',
        cropSourceManifestAssetId: 'crop-asset',
        canonicalFrameCount: 3n,
        status: 'READY',
      }),
    })
    expect(tx.personPoseEvidenceChunk.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ chunkIndex: 0, startFrameIndex: 0n, endFrameIndex: 1n }),
        expect.objectContaining({ chunkIndex: 1, startFrameIndex: 2n, endFrameIndex: 2n }),
      ],
    })
  })

  it('rejects a frame gap before creating any evidence rows', async () => {
    const tx = transaction()
    const input = fixture()
    ;(input.poseManifest.chunks as Array<Record<string, unknown>>)[1]!.start_frame_index = '3'

    await expect(
      registerProviderAnalysisEvidence(tx as unknown as Prisma.TransactionClient, input),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ProviderAnalysisMaterializationError>>({
        name: 'ProviderAnalysisMaterializationError',
        retryable: false,
      }),
    )
    expect(tx.analysisEvidenceBundle.create).not.toHaveBeenCalled()
  })
})
