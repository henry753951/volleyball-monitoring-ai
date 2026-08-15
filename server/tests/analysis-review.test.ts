import type { AnalysisReviewPatch } from '@volleyball-monitoring/contracts'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import { describe, expect, it, vi } from 'vitest'
import type { AnalysisReviewError } from '../src/services/analysis-review.js'
import { applyAnalysisReviewPatch, readAnalysisReview } from '../src/services/analysis-review.js'

const analysisRunId = '85000000-0000-4000-8000-000000000002'
const identity = { userId: '85000000-0000-4000-8000-000000000003', role: UserRole.OPERATOR }
const patch: AnalysisReviewPatch = {
  schema_version: '1.4.0',
  client_patch_id: '85000000-0000-4000-8000-000000000001',
  base_revision: '2',
  operations: [
    { op: 'set_ball_position', frame_index: '12', frame_pos: { x: 640, y: 360 } },
    { op: 'set_action', frame_index: '12', track_id: 5, action: 'Spiking' },
    {
      op: 'set_player_bbox',
      frame_index: '12',
      track_id: 5,
      frame_bbox: { x1: 400, y1: 100, x2: 800, y2: 900 },
    },
    { op: 'set_contact_actor', key_point_id: '85000000-0000-4000-8000-000000000004', track_id: 5 },
    {
      op: 'set_contact_time',
      key_point_id: '85000000-0000-4000-8000-000000000004',
      frame_index: '13',
    },
  ],
}

function authorizedRun() {
  return {
    id: analysisRunId,
    reviewRevision: 2n,
    analysisDataManifest: { totalFrames: 120n, videoHeight: 1080, videoWidth: 1920 },
    tracks: [{ trackId: 5, firstFrame: 10n, lastFrame: 20n }],
    contactEvents: [
      {
        keyPointId: '85000000-0000-4000-8000-000000000004',
        sequenceIndex: 0,
        anchorOrigin: 'ai_detected',
        anchorFrameIndex: 12n,
        resolvedFrameIndex: 12n,
      },
    ],
  }
}

describe('analysis review corrections', () => {
  it('commits a compact idempotent patch at one shared revision', async () => {
    const tx = {
      analysisActionCorrection: {
        upsert: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      analysisBallCorrection: {
        upsert: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      analysisPlayerBBoxCorrection: {
        upsert: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      analysisContactActorCorrection: {
        upsert: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      analysisContactTimeCorrection: {
        upsert: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      analysisContactAssociationJob: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
      analysisReviewPatchReceipt: {
        create: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue(null),
      },
      analysisRun: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ reviewRevision: 2n }),
        update: vi.fn().mockResolvedValue({ reviewRevision: 3n }),
      },
    }
    const database = {
      analysisRun: { findFirst: vi.fn().mockResolvedValue(authorizedRun()) },
      analysisContactTimeCorrection: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    } as unknown as PrismaClient

    await expect(
      applyAnalysisReviewPatch(database, { analysisRunId, identity, patch }),
    ).resolves.toEqual({
      schema_version: '1.4.0',
      analysis_run_id: analysisRunId,
      revision: '3',
      duplicate: false,
      rebased: false,
    })
    expect(tx.analysisBallCorrection.upsert).toHaveBeenCalledOnce()
    expect(tx.analysisActionCorrection.upsert).toHaveBeenCalledOnce()
    expect(tx.analysisPlayerBBoxCorrection.upsert).toHaveBeenCalledOnce()
    expect(tx.analysisContactActorCorrection.upsert).toHaveBeenCalledOnce()
    expect(tx.analysisContactTimeCorrection.upsert).toHaveBeenCalledOnce()
    expect(tx.analysisContactAssociationJob.createMany).toHaveBeenCalledWith({
      data: [
        {
          analysisRunId,
          keyPointId: '85000000-0000-4000-8000-000000000004',
          reviewRevision: 3n,
          frameIndex: 13n,
          algorithmNamespace: 'contact-association/coco17-pose-first-v1',
        },
      ],
      skipDuplicates: true,
    })
    expect(tx.analysisReviewPatchReceipt.create).toHaveBeenCalledWith({
      data: { id: patch.client_patch_id, analysisRunId, revision: 3n },
    })
  })

  it('rejects action edits outside the selected track lifetime', async () => {
    const database = {
      analysisRun: { findFirst: vi.fn().mockResolvedValue(authorizedRun()) },
      analysisContactTimeCorrection: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(),
    } as unknown as PrismaClient
    const outside: AnalysisReviewPatch = {
      ...patch,
      operations: [{ op: 'set_action', frame_index: '21', track_id: 5, action: 'Standing' }],
    }

    await expect(
      applyAnalysisReviewPatch(database, { analysisRunId, identity, patch: outside }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AnalysisReviewError>>({ code: 'TRACK_NOT_ACTIVE' }),
    )
    expect(database.$transaction).not.toHaveBeenCalled()
  })

  it('validates a corrected actor against the effective contact time in the same patch', async () => {
    const run = {
      ...authorizedRun(),
      tracks: [{ trackId: 5, firstFrame: 13n, lastFrame: 20n }],
    }
    const reachedTransaction = new Error('transaction reached')
    const database = {
      analysisRun: { findFirst: vi.fn().mockResolvedValue(run) },
      analysisContactTimeCorrection: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn().mockRejectedValue(reachedTransaction),
    } as unknown as PrismaClient
    const combined: AnalysisReviewPatch = {
      ...patch,
      operations: [
        {
          op: 'set_contact_actor',
          key_point_id: '85000000-0000-4000-8000-000000000004',
          track_id: 5,
        },
        {
          op: 'set_contact_time',
          key_point_id: '85000000-0000-4000-8000-000000000004',
          frame_index: '13',
        },
      ],
    }

    await expect(
      applyAnalysisReviewPatch(database, { analysisRunId, identity, patch: combined }),
    ).rejects.toBe(reachedTransaction)
    expect(database.$transaction).toHaveBeenCalledOnce()
  })

  it('rejects an AI contact-time correction that crosses a neighboring event', async () => {
    const generatedId = '85000000-0000-4000-8000-000000000005'
    const run = {
      ...authorizedRun(),
      contactEvents: [
        {
          keyPointId: '85000000-0000-4000-8000-000000000006',
          sequenceIndex: 0,
          anchorOrigin: 'human_anchor',
          anchorFrameIndex: 10n,
          resolvedFrameIndex: 10n,
        },
        {
          keyPointId: generatedId,
          sequenceIndex: 1,
          anchorOrigin: 'ai_detected',
          anchorFrameIndex: 15n,
          resolvedFrameIndex: 15n,
        },
        {
          keyPointId: '85000000-0000-4000-8000-000000000007',
          sequenceIndex: 2,
          anchorOrigin: 'human_anchor',
          anchorFrameIndex: 20n,
          resolvedFrameIndex: 20n,
        },
      ],
    }
    const database = {
      analysisRun: { findFirst: vi.fn().mockResolvedValue(run) },
      analysisContactTimeCorrection: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(),
    } as unknown as PrismaClient
    const crossing: AnalysisReviewPatch = {
      ...patch,
      operations: [{ op: 'set_contact_time', key_point_id: generatedId, frame_index: '20' }],
    }

    await expect(
      applyAnalysisReviewPatch(database, { analysisRunId, identity, patch: crossing }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AnalysisReviewError>>({ code: 'FRAME_OUT_OF_RANGE' }),
    )
    expect(database.$transaction).not.toHaveBeenCalled()
  })

  it('returns the complete sparse current state even when a caller supplies an older revision', async () => {
    const database = {
      analysisRun: { findFirst: vi.fn().mockResolvedValue(authorizedRun()) },
      analysisBallCorrection: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { frameIndex: 12n, frameX: null, frameY: null, visible: false, revision: 3n },
          ]),
      },
      analysisActionCorrection: { findMany: vi.fn().mockResolvedValue([]) },
      analysisPlayerBBoxCorrection: { findMany: vi.fn().mockResolvedValue([]) },
      analysisContactActorCorrection: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { keyPointId: '85000000-0000-4000-8000-000000000004', trackId: null, revision: 3n },
          ]),
      },
      analysisContactAssociationJob: {
        findMany: vi.fn().mockResolvedValue([
          {
            keyPointId: '85000000-0000-4000-8000-000000000004',
            frameIndex: 13n,
            reviewRevision: 3n,
            algorithmNamespace: 'contact-association/coco17-pose-first-v1',
            status: 'COMPLETED',
            errorCode: null,
            projection: {
              trackId: 5,
              observationFrameIndex: 13n,
              source: 'POSE_HAND',
              confidence: 0.9,
              poseRecipeNamespace: 'person-pose/coco17-v1',
              fallbackReason: null,
            },
          },
        ]),
      },
      analysisContactTimeCorrection: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { keyPointId: '85000000-0000-4000-8000-000000000004', frameIndex: 13n, revision: 3n },
          ]),
      },
    } as unknown as PrismaClient

    await expect(
      readAnalysisReview(database, { analysisRunId, afterRevision: 2n, identity }),
    ).resolves.toEqual(
      expect.objectContaining({
        schema_version: '1.4.0',
        contact_actor_projections: [
          {
            key_point_id: '85000000-0000-4000-8000-000000000004',
            frame_index: '13',
            status: 'ready',
            track_id: 5,
            observation_frame_index: '13',
            source: 'pose_hand',
            confidence: 0.9,
            algorithm_namespace: 'contact-association/coco17-pose-first-v1',
            pose_recipe_namespace: 'person-pose/coco17-v1',
            fallback_reason: null,
            revision: '3',
          },
        ],
        ball_corrections: [{ frame_index: '12', state: 'missing', frame_pos: null, revision: '3' }],
        contact_actor_corrections: [
          { key_point_id: '85000000-0000-4000-8000-000000000004', track_id: null, revision: '3' },
        ],
        contact_time_corrections: [
          {
            key_point_id: '85000000-0000-4000-8000-000000000004',
            frame_index: '13',
            revision: '3',
          },
        ],
      }),
    )
    expect(database.analysisBallCorrection.findMany).toHaveBeenCalledWith(
      expect.not.objectContaining({
        where: expect.objectContaining({ revision: expect.anything() }),
      }),
    )
  })
})
