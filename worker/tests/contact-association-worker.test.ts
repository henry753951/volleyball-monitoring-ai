import {
  ANALYSIS_MISSING_ACTION_LABEL,
  encodeAnalysisFrameChunk,
  encodePersonPoseEvidenceChunk,
  PERSON_POSE_BBOX_SOURCE,
  PERSON_POSE_KEYPOINT_COUNT,
  PERSON_POSE_OBSERVATION_HASH_BYTES,
  PERSON_POSE_STATUS,
  type AnalysisFrameChunk,
  type PersonPoseEvidenceChunk,
} from '@volleyball-monitoring/contracts'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { JobStatus } from '@volleyball-monitoring/db/client'
import { describe, expect, it, vi } from 'vitest'
import { materializeContactAssociationJob } from '../src/roles/contact-association-worker.js'
import type { WorkflowMinio } from '../src/workflow/minio.js'

const analysisRunId = '85000000-0000-4000-8000-000000000020'
const jobId = '85000000-0000-4000-8000-000000000021'
const keyPointId = '85000000-0000-4000-8000-000000000022'

function frameChunk(): AnalysisFrameChunk {
  return {
    schemaVersion: 10_000,
    analysisId: 'analysis-1',
    analysisDataVersion: '1',
    chunkIndex: 0,
    startFrameIndex: 42n,
    frameCount: 1,
    frameOffsets: [0, 2],
    trackIds: [1, 2],
    frameBboxes: [
      { x1: 26_214, y1: 16_383, x2: 39_321, y2: 55_705 },
      { x1: 42_598, y1: 16_383, x2: 55_705, y2: 55_705 },
    ],
    frameFootPositions: [
      { x: 32_768, y: 55_705 },
      { x: 49_152, y: 55_705 },
    ],
    courtPositions: [
      { x: 0.25, y: 0.5 },
      { x: 0.75, y: 0.5 },
    ],
    playerFlags: [1, 1],
    playerConfidences: [230, 230],
    actionLabelIds: [ANALYSIS_MISSING_ACTION_LABEL, 0],
    actionConfidences: [255, 250],
    ballFramePositions: [{ x: 32_768, y: 29_491 }],
    ballFlags: [1],
    ballConfidences: [240],
    courtKeypointFrameOffsets: [0, 0],
    courtKeypointIds: [],
    courtKeypointPositions: [],
    courtKeypointConfidences: [],
  }
}

function poseChunk(): PersonPoseEvidenceChunk {
  const keypointCount = PERSON_POSE_KEYPOINT_COUNT * 2
  const keypointX = Array.from({ length: keypointCount }, () => -1)
  const keypointY = Array.from({ length: keypointCount }, () => -1)
  const keypointConfidence = Array.from({ length: keypointCount }, () => -1)
  for (const [observation, wristX] of [
    [0, 0.505],
    [1, 0.72],
  ] as const) {
    const offset = observation * PERSON_POSE_KEYPOINT_COUNT
    keypointX[offset + 7] = wristX
    keypointY[offset + 7] = 0.51
    keypointConfidence[offset + 7] = 0.9
    keypointX[offset + 9] = wristX
    keypointY[offset + 9] = 0.45
    keypointConfidence[offset + 9] = 0.95
  }
  return {
    schemaVersion: '1.0.0',
    analysisRunId,
    poseRecipeNamespace: 'person-pose/coco17-v1',
    startFrameIndex: 42n,
    frameCount: 1,
    frameOffsets: [0, 2],
    trackIds: [1, 2],
    bboxSources: [PERSON_POSE_BBOX_SOURCE.detector, PERSON_POSE_BBOX_SOURCE.detector],
    bboxX1: [0.4, 0.65],
    bboxY1: [0.25, 0.25],
    bboxX2: [0.6, 0.85],
    bboxY2: [0.85, 0.85],
    cropScaleX: [1 / 1920, 1 / 1920],
    cropScaleY: [1 / 1080, 1 / 1080],
    cropOffsetX: [0.4, 0.65],
    cropOffsetY: [0.25, 0.25],
    statuses: [PERSON_POSE_STATUS.available, PERSON_POSE_STATUS.available],
    observationSha256: Array.from({ length: PERSON_POSE_OBSERVATION_HASH_BYTES * 2 }, () => 0),
    keypointX,
    keypointY,
    keypointConfidence,
  }
}

describe('contact association durable materializer', () => {
  it('reads registered exact-frame evidence and writes a projection without scheduling model work', async () => {
    const loaded = {
      id: jobId,
      analysisRunId,
      keyPointId,
      reviewRevision: 4n,
      frameIndex: 42n,
      algorithmNamespace: 'contact-association/coco17-pose-first-v1',
      status: JobStatus.RUNNING,
      projection: null,
      analysisRun: {
        id: analysisRunId,
        analysisId: 'analysis-1',
        status: JobStatus.COMPLETED,
        analysisDataManifest: {
          videoWidth: 1920,
          videoHeight: 1080,
          actionTaxonomy: { labels: ['Spiking'] },
          chunks: [
            {
              chunkIndex: 0,
              startFrameIndex: 42n,
              frameCount: 1,
              assetId: 'frame-asset',
              sha256: 'a'.repeat(64),
              asset: {
                id: 'frame-asset',
                bucket: 'analysis',
                objectKey: 'frame.vfc1',
                byteLength: 1n,
                sha256: 'a'.repeat(64),
              },
            },
          ],
        },
        personPoseEvidenceManifests: [
          {
            id: 'pose-manifest',
            recipeNamespace: 'person-pose/coco17-v1',
            contentSha256: 'b'.repeat(64),
            chunks: [
              {
                chunkIndex: 0,
                startFrameIndex: 42n,
                endFrameIndex: 42n,
                assetId: 'pose-asset',
                sha256: 'c'.repeat(64),
                asset: {
                  id: 'pose-asset',
                  bucket: 'analysis',
                  objectKey: 'pose.vpe1',
                  byteLength: 1n,
                  sha256: 'c'.repeat(64),
                },
              },
            ],
          },
        ],
        ballCorrections: [],
        actionCorrections: [],
        playerBBoxCorrections: [],
      },
    }
    const projection = { id: 'projection-1' }
    const tx = {
      analysisContactAssociationJob: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue({ status: JobStatus.RUNNING, projection: null }),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      analysisContactAssociationProjection: {
        create: vi.fn().mockResolvedValue(projection),
      },
    }
    const database = {
      analysisContactAssociationJob: { findUnique: vi.fn().mockResolvedValue(loaded) },
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    } as unknown as PrismaClient
    const bytes = new Map([
      ['frame.vfc1', Buffer.from(encodeAnalysisFrameChunk(frameChunk()))],
      ['pose.vpe1', Buffer.from(encodePersonPoseEvidenceChunk(poseChunk()))],
    ])
    const readObject = vi.fn(async (_client, asset: { objectKey: string }) =>
      bytes.get(asset.objectKey)!,
    )
    const storage = {
      client: {},
      analysisBucket: 'analysis',
      rallyBucket: 'rally',
    } as WorkflowMinio

    await expect(
      materializeContactAssociationJob(database, jobId, storage, readObject as never),
    ).resolves.toBe('projection-1')
    expect(tx.analysisContactAssociationProjection.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobId,
        analysisRunId,
        keyPointId,
        reviewRevision: 4n,
        frameIndex: 42n,
        observationFrameIndex: 42n,
        trackId: 1,
        source: 'POSE_HAND',
        algorithmNamespace: 'contact-association/coco17-pose-first-v1',
        poseRecipeNamespace: 'person-pose/coco17-v1',
        fallbackReason: null,
      }),
    })
    expect((database as never as { providerJob?: unknown }).providerJob).toBeUndefined()
  })
})
