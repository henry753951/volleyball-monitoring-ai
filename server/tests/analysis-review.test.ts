import type { AnalysisReviewPatch } from '@volleyball-monitoring/contracts'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'
import { describe, expect, it, vi } from 'vitest'
import { AnalysisReviewError, applyAnalysisReviewPatch } from '../src/services/analysis-review.js'

const analysisRunId = '85000000-0000-4000-8000-000000000002'
const identity = { userId: '85000000-0000-4000-8000-000000000003', role: UserRole.OPERATOR }
const patch: AnalysisReviewPatch = {
  schema_version: '1.0.0',
  client_patch_id: '85000000-0000-4000-8000-000000000001',
  base_revision: '2',
  operations: [
    { op: 'set_ball_position', frame_index: '12', frame_pos: { x: 640, y: 360 } },
    { op: 'set_action', frame_index: '12', track_id: 5, action: 'Spiking' },
  ],
}

function authorizedRun() {
  return {
    id: analysisRunId,
    reviewRevision: 2n,
    overlayManifest: { totalFrames: 120n, videoHeight: 1080, videoWidth: 1920 },
    tracks: [{ trackId: 5, firstFrame: 10n, lastFrame: 20n }],
  }
}

describe('analysis review corrections', () => {
  it('commits a compact idempotent patch at one shared revision', async () => {
    const tx = {
      analysisActionCorrection: { upsert: vi.fn().mockResolvedValue({}) },
      analysisBallCorrection: { upsert: vi.fn().mockResolvedValue({}) },
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
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    } as unknown as PrismaClient

    await expect(applyAnalysisReviewPatch(database, { analysisRunId, identity, patch })).resolves.toEqual({
      schema_version: '1.0.0',
      analysis_run_id: analysisRunId,
      revision: '3',
      duplicate: false,
      rebased: false,
    })
    expect(tx.analysisBallCorrection.upsert).toHaveBeenCalledOnce()
    expect(tx.analysisActionCorrection.upsert).toHaveBeenCalledOnce()
    expect(tx.analysisReviewPatchReceipt.create).toHaveBeenCalledWith({
      data: { id: patch.client_patch_id, analysisRunId, revision: 3n },
    })
  })

  it('rejects action edits outside the selected track lifetime', async () => {
    const database = {
      analysisRun: { findFirst: vi.fn().mockResolvedValue(authorizedRun()) },
      $transaction: vi.fn(),
    } as unknown as PrismaClient
    const outside: AnalysisReviewPatch = {
      ...patch,
      operations: [{ op: 'set_action', frame_index: '21', track_id: 5, action: 'Standing' }],
    }

    await expect(applyAnalysisReviewPatch(database, { analysisRunId, identity, patch: outside }))
      .rejects.toEqual(expect.objectContaining<Partial<AnalysisReviewError>>({ code: 'TRACK_NOT_ACTIVE' }))
    expect(database.$transaction).not.toHaveBeenCalled()
  })
})
