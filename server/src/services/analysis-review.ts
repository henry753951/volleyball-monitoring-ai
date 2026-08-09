import {
  ANALYSIS_REVIEW_SCHEMA_VERSION,
  type AnalysisReviewPatch,
  type AnalysisReviewState,
} from '@volleyball-monitoring/contracts'
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
      contactEvents: { select: { keyPointId: true, anchorFrameIndex: true, resolvedFrameIndex: true } },
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
  // Version 1.1 returns the complete sparse current state. That makes deletions
  // (restore automatic analysis) converge after a revision invalidation.
  const [ball, action, bbox, contactActor] = await Promise.all([
    database.analysisBallCorrection.findMany({ where: { analysisRunId: input.analysisRunId }, orderBy: { frameIndex: 'asc' } }),
    database.analysisActionCorrection.findMany({ where: { analysisRunId: input.analysisRunId }, orderBy: [{ frameIndex: 'asc' }, { trackId: 'asc' }] }),
    database.analysisPlayerBBoxCorrection.findMany({ where: { analysisRunId: input.analysisRunId }, orderBy: [{ frameIndex: 'asc' }, { trackId: 'asc' }] }),
    database.analysisContactActorCorrection.findMany({ where: { analysisRunId: input.analysisRunId }, orderBy: { keyPointId: 'asc' } }),
  ])
  return {
    schema_version: ANALYSIS_REVIEW_SCHEMA_VERSION,
    analysis_run_id: run.id,
    revision: run.reviewRevision.toString(),
    ball_corrections: ball.map(item => item.visible
      ? { frame_index: item.frameIndex.toString(), state: 'position' as const, frame_pos: { x: item.frameX!, y: item.frameY! }, revision: item.revision.toString() }
      : { frame_index: item.frameIndex.toString(), state: 'missing' as const, frame_pos: null, revision: item.revision.toString() }),
    action_corrections: action.map(item => ({ frame_index: item.frameIndex.toString(), track_id: item.trackId, action: item.action as AnalysisReviewState['action_corrections'][number]['action'], revision: item.revision.toString() })),
    player_bbox_corrections: bbox.map(item => ({ frame_index: item.frameIndex.toString(), track_id: item.trackId, frame_bbox: { x1: item.frameX1, y1: item.frameY1, x2: item.frameX2, y2: item.frameY2 }, revision: item.revision.toString() })),
    contact_actor_corrections: contactActor.map(item => ({ key_point_id: item.keyPointId, track_id: item.trackId, revision: item.revision.toString() })),
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
  const contacts = new Map(run.contactEvents.map(event => [event.keyPointId, event]))
  const assertFrame = (frameIndex: bigint) => {
    if (frameIndex >= totalFrames) throw new AnalysisReviewError('FRAME_OUT_OF_RANGE', 'frame is outside the analysis overlay')
  }
  const assertTrack = (trackId: number, frameIndex: bigint) => {
    const track = tracks.get(trackId)
    if (!track || frameIndex < track.firstFrame || frameIndex > track.lastFrame) {
      throw new AnalysisReviewError('TRACK_NOT_ACTIVE', 'track is not active on this frame')
    }
  }
  for (const operation of input.patch.operations) {
    if (operation.op === 'set_contact_actor' || operation.op === 'clear_contact_actor_override') {
      const contact = contacts.get(operation.key_point_id)
      if (!contact) throw new AnalysisReviewError('NOT_FOUND', 'contact event is unavailable')
      if (operation.op === 'set_contact_actor' && operation.track_id !== null) {
        assertTrack(operation.track_id, contact.resolvedFrameIndex ?? contact.anchorFrameIndex)
      }
      continue
    }
    const frameIndex = BigInt(operation.frame_index)
    assertFrame(frameIndex)
    if (operation.op === 'set_ball_position') {
      if (operation.frame_pos.x > run.overlayManifest.videoWidth || operation.frame_pos.y > run.overlayManifest.videoHeight) {
        throw new AnalysisReviewError('FRAME_OUT_OF_RANGE', 'ball position is outside the video frame')
      }
      continue
    }
    if (operation.op === 'mark_ball_missing' || operation.op === 'clear_ball_override') continue
    assertTrack(operation.track_id, frameIndex)
    if (operation.op === 'set_player_bbox') {
      const bbox = operation.frame_bbox
      if (bbox.x2 > run.overlayManifest.videoWidth || bbox.y2 > run.overlayManifest.videoHeight) {
        throw new AnalysisReviewError('FRAME_OUT_OF_RANGE', 'player box is outside the video frame')
      }
    }
  }

  const result = await database.$transaction(async (tx) => {
    const duplicate = await tx.analysisReviewPatchReceipt.findUnique({ where: { id: input.patch.client_patch_id } })
    if (duplicate) return { revision: duplicate.revision, duplicate: true, rebased: false }
    const before = await tx.analysisRun.findUniqueOrThrow({ where: { id: input.analysisRunId }, select: { reviewRevision: true } })
    const updated = await tx.analysisRun.update({ where: { id: input.analysisRunId }, data: { reviewRevision: { increment: 1 } }, select: { reviewRevision: true } })
    for (const operation of input.patch.operations) {
      if (operation.op === 'set_contact_actor') {
        await tx.analysisContactActorCorrection.upsert({
          where: { analysisRunId_keyPointId: { analysisRunId: input.analysisRunId, keyPointId: operation.key_point_id } },
          create: { analysisRunId: input.analysisRunId, keyPointId: operation.key_point_id, trackId: operation.track_id, revision: updated.reviewRevision, updatedByUserId: input.identity.userId },
          update: { trackId: operation.track_id, revision: updated.reviewRevision, updatedByUserId: input.identity.userId },
        })
        continue
      }
      if (operation.op === 'clear_contact_actor_override') {
        await tx.analysisContactActorCorrection.deleteMany({ where: { analysisRunId: input.analysisRunId, keyPointId: operation.key_point_id } })
        continue
      }
      const frameIndex = BigInt(operation.frame_index)
      if (operation.op === 'set_ball_position') {
        await tx.analysisBallCorrection.upsert({
          where: { analysisRunId_frameIndex: { analysisRunId: input.analysisRunId, frameIndex } },
          create: { analysisRunId: input.analysisRunId, frameIndex, frameX: operation.frame_pos.x, frameY: operation.frame_pos.y, visible: true, revision: updated.reviewRevision, updatedByUserId: input.identity.userId },
          update: { frameX: operation.frame_pos.x, frameY: operation.frame_pos.y, visible: true, revision: updated.reviewRevision, updatedByUserId: input.identity.userId },
        })
      }
      else if (operation.op === 'mark_ball_missing') {
        await tx.analysisBallCorrection.upsert({
          where: { analysisRunId_frameIndex: { analysisRunId: input.analysisRunId, frameIndex } },
          create: { analysisRunId: input.analysisRunId, frameIndex, frameX: null, frameY: null, visible: false, revision: updated.reviewRevision, updatedByUserId: input.identity.userId },
          update: { frameX: null, frameY: null, visible: false, revision: updated.reviewRevision, updatedByUserId: input.identity.userId },
        })
      }
      else if (operation.op === 'clear_ball_override') {
        await tx.analysisBallCorrection.deleteMany({ where: { analysisRunId: input.analysisRunId, frameIndex } })
      }
      else if (operation.op === 'set_action') {
        await tx.analysisActionCorrection.upsert({
          where: { analysisRunId_frameIndex_trackId: { analysisRunId: input.analysisRunId, frameIndex, trackId: operation.track_id } },
          create: { analysisRunId: input.analysisRunId, frameIndex, trackId: operation.track_id, action: operation.action, revision: updated.reviewRevision, updatedByUserId: input.identity.userId },
          update: { action: operation.action, revision: updated.reviewRevision, updatedByUserId: input.identity.userId },
        })
      }
      else if (operation.op === 'clear_action_override') {
        await tx.analysisActionCorrection.deleteMany({ where: { analysisRunId: input.analysisRunId, frameIndex, trackId: operation.track_id } })
      }
      else if (operation.op === 'set_player_bbox') {
        const bbox = operation.frame_bbox
        await tx.analysisPlayerBBoxCorrection.upsert({
          where: { analysisRunId_frameIndex_trackId: { analysisRunId: input.analysisRunId, frameIndex, trackId: operation.track_id } },
          create: { analysisRunId: input.analysisRunId, frameIndex, trackId: operation.track_id, frameX1: bbox.x1, frameY1: bbox.y1, frameX2: bbox.x2, frameY2: bbox.y2, revision: updated.reviewRevision, updatedByUserId: input.identity.userId },
          update: { frameX1: bbox.x1, frameY1: bbox.y1, frameX2: bbox.x2, frameY2: bbox.y2, revision: updated.reviewRevision, updatedByUserId: input.identity.userId },
        })
      }
      else {
        await tx.analysisPlayerBBoxCorrection.deleteMany({ where: { analysisRunId: input.analysisRunId, frameIndex, trackId: operation.track_id } })
      }
    }
    await tx.analysisReviewPatchReceipt.create({ data: { id: input.patch.client_patch_id, analysisRunId: input.analysisRunId, revision: updated.reviewRevision } })
    return { revision: updated.reviewRevision, duplicate: false, rebased: BigInt(input.patch.base_revision) !== before.reviewRevision }
  })
  return { schema_version: ANALYSIS_REVIEW_SCHEMA_VERSION, analysis_run_id: input.analysisRunId, revision: result.revision.toString(), duplicate: result.duplicate, rebased: result.rebased }
}
