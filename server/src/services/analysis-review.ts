import type { AnalysisReviewPatch, AnalysisReviewState } from '@volleyball-monitoring/contracts'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { JobStatus, UserRole } from '@volleyball-monitoring/db/client'

interface ReviewIdentity { userId: string; role: UserRole }
const WRITE_ROLES = new Set<UserRole>([UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR, UserRole.COACH])

export class AnalysisReviewError extends Error {
  constructor(public readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'FRAME_OUT_OF_RANGE' | 'TRACK_NOT_ACTIVE', message: string) {
    super(message)
  }
}

async function authorizedRun(database: PrismaClient, analysisRunId: string, identity: ReviewIdentity) {
  return database.analysisRun.findFirst({
    where: {
      id: analysisRunId,
      status: JobStatus.COMPLETED,
      submission: {
        rally: {
          voidedAt: null,
          ...(identity.role === UserRole.ADMIN ? {} : { match: { members: { some: { userId: identity.userId } } } }),
        },
      },
    },
    select: {
      id: true,
      reviewRevision: true,
      overlayManifest: { select: { totalFrames: true, videoHeight: true, videoWidth: true } },
      tracks: { select: { trackId: true, firstFrame: true, lastFrame: true } },
    },
  })
}

export async function canReadAnalysisReview(database: PrismaClient, analysisRunId: string, identity: ReviewIdentity) {
  return Boolean(await authorizedRun(database, analysisRunId, identity))
}

export async function readAnalysisReview(
  database: PrismaClient,
  input: { analysisRunId: string; afterRevision?: bigint; identity: ReviewIdentity },
): Promise<AnalysisReviewState | null> {
  const run = await authorizedRun(database, input.analysisRunId, input.identity)
  if (!run) return null
  const revisionFilter = input.afterRevision === undefined ? {} : { revision: { gt: input.afterRevision } }
  const [ball, action] = await Promise.all([
    database.analysisBallCorrection.findMany({ where: { analysisRunId: input.analysisRunId, ...revisionFilter }, orderBy: [{ revision: 'asc' }, { frameIndex: 'asc' }] }),
    database.analysisActionCorrection.findMany({ where: { analysisRunId: input.analysisRunId, ...revisionFilter }, orderBy: [{ revision: 'asc' }, { frameIndex: 'asc' }, { trackId: 'asc' }] }),
  ])
  return {
    schema_version: '1.0.0',
    analysis_run_id: run.id,
    revision: run.reviewRevision.toString(),
    ball_corrections: ball.map(item => ({ frame_index: item.frameIndex.toString(), frame_pos: { x: item.frameX, y: item.frameY }, revision: item.revision.toString() })),
    action_corrections: action.map(item => ({ frame_index: item.frameIndex.toString(), track_id: item.trackId, action: item.action as AnalysisReviewState['action_corrections'][number]['action'], revision: item.revision.toString() })),
  }
}

export async function applyAnalysisReviewPatch(
  database: PrismaClient,
  input: { analysisRunId: string; patch: AnalysisReviewPatch; identity: ReviewIdentity },
) {
  if (!WRITE_ROLES.has(input.identity.role)) {
    throw new AnalysisReviewError('FORBIDDEN', 'analysis review is read-only for this role')
  }
  const run = await authorizedRun(database, input.analysisRunId, input.identity)
  if (!run || !run.overlayManifest) throw new AnalysisReviewError('NOT_FOUND', 'analysis review is unavailable')
  const totalFrames = run.overlayManifest.totalFrames
  const tracks = new Map(run.tracks.map(track => [track.trackId, track]))
  for (const operation of input.patch.operations) {
    const frameIndex = BigInt(operation.frame_index)
    if (frameIndex >= totalFrames) throw new AnalysisReviewError('FRAME_OUT_OF_RANGE', 'frame is outside the analysis overlay')
    if (operation.op === 'set_ball_position') {
      if (operation.frame_pos.x > run.overlayManifest.videoWidth || operation.frame_pos.y > run.overlayManifest.videoHeight) {
        throw new AnalysisReviewError('FRAME_OUT_OF_RANGE', 'ball position is outside the video frame')
      }
      continue
    }
    const track = tracks.get(operation.track_id)
    if (!track || frameIndex < track.firstFrame || frameIndex > track.lastFrame) {
      throw new AnalysisReviewError('TRACK_NOT_ACTIVE', 'track is not active on this frame')
    }
  }

  const result = await database.$transaction(async (tx) => {
    const duplicate = await tx.analysisReviewPatchReceipt.findUnique({ where: { id: input.patch.client_patch_id } })
    if (duplicate) return { revision: duplicate.revision, duplicate: true, rebased: false }
    const before = await tx.analysisRun.findUniqueOrThrow({ where: { id: input.analysisRunId }, select: { reviewRevision: true } })
    const updated = await tx.analysisRun.update({ where: { id: input.analysisRunId }, data: { reviewRevision: { increment: 1 } }, select: { reviewRevision: true } })
    for (const operation of input.patch.operations) {
      const frameIndex = BigInt(operation.frame_index)
      if (operation.op === 'set_ball_position') {
        await tx.analysisBallCorrection.upsert({
          where: { analysisRunId_frameIndex: { analysisRunId: input.analysisRunId, frameIndex } },
          create: { analysisRunId: input.analysisRunId, frameIndex, frameX: operation.frame_pos.x, frameY: operation.frame_pos.y, revision: updated.reviewRevision, updatedByUserId: input.identity.userId },
          update: { frameX: operation.frame_pos.x, frameY: operation.frame_pos.y, revision: updated.reviewRevision, updatedByUserId: input.identity.userId },
        })
      }
      else {
        await tx.analysisActionCorrection.upsert({
          where: { analysisRunId_frameIndex_trackId: { analysisRunId: input.analysisRunId, frameIndex, trackId: operation.track_id } },
          create: { analysisRunId: input.analysisRunId, frameIndex, trackId: operation.track_id, action: operation.action, revision: updated.reviewRevision, updatedByUserId: input.identity.userId },
          update: { action: operation.action, revision: updated.reviewRevision, updatedByUserId: input.identity.userId },
        })
      }
    }
    await tx.analysisReviewPatchReceipt.create({ data: { id: input.patch.client_patch_id, analysisRunId: input.analysisRunId, revision: updated.reviewRevision } })
    return { revision: updated.reviewRevision, duplicate: false, rebased: BigInt(input.patch.base_revision) !== before.reviewRevision }
  })
  return { schema_version: '1.0.0' as const, analysis_run_id: input.analysisRunId, revision: result.revision.toString(), duplicate: result.duplicate, rebased: result.rebased }
}
