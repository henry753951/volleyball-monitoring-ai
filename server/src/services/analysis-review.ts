import {
  ANALYSIS_REVIEW_SCHEMA_VERSION,
  type AnalysisReviewPatch,
  type AnalysisReviewState,
} from '@volleyball-monitoring/contracts'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { AnalysisReviewStatus, JobStatus, UserRole } from '@volleyball-monitoring/db/client'

interface ReviewIdentity { userId: string; role: UserRole }
const WRITE_ROLES = new Set<UserRole>([UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR, UserRole.COACH])

export class AnalysisReviewError extends Error {
  constructor(public readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'FRAME_OUT_OF_RANGE' | 'TRACK_NOT_ACTIVE' | 'REVIEW_NOT_READY', message: string) {
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
      reviewStatus: true,
      reviewComputedRevision: true,
      reviewApprovedRevision: true,
      analysisDataManifest: { select: { totalFrames: true, videoHeight: true, videoWidth: true } },
      tracks: { select: { trackId: true, firstFrame: true, lastFrame: true } },
      contactEvents: { select: { keyPointId: true, sequenceIndex: true, anchorOrigin: true, anchorFrameIndex: true, resolvedFrameIndex: true, actors: { orderBy: { associationConfidence: 'desc' }, take: 1, select: { trackId: true } } }, orderBy: { sequenceIndex: 'asc' } },
      contactEdits: { select: { contactId: true, baseKeyPointId: true, frameIndex: true, trackId: true, deleted: true, revision: true } },
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
  // Version 1.2 returns the complete sparse current state. That makes deletions
  // (restore automatic analysis) converge after a revision invalidation.
  const [ball, action, bbox, contactActor, contactTime, contactEdits] = await Promise.all([
    database.analysisBallCorrection.findMany({ where: { analysisRunId: input.analysisRunId }, orderBy: { frameIndex: 'asc' } }),
    database.analysisActionCorrection.findMany({ where: { analysisRunId: input.analysisRunId }, orderBy: [{ frameIndex: 'asc' }, { trackId: 'asc' }] }),
    database.analysisPlayerBBoxCorrection.findMany({ where: { analysisRunId: input.analysisRunId }, orderBy: [{ frameIndex: 'asc' }, { trackId: 'asc' }] }),
    database.analysisContactActorCorrection.findMany({ where: { analysisRunId: input.analysisRunId }, orderBy: { keyPointId: 'asc' } }),
    database.analysisContactTimeCorrection.findMany({ where: { analysisRunId: input.analysisRunId }, orderBy: { keyPointId: 'asc' } }),
    database.analysisContactEdit?.findMany({ where: { analysisRunId: input.analysisRunId }, orderBy: [{ frameIndex: 'asc' }, { contactId: 'asc' }] }) ?? Promise.resolve([]),
  ])
  return {
    schema_version: ANALYSIS_REVIEW_SCHEMA_VERSION,
    analysis_run_id: run.id,
    revision: run.reviewRevision.toString(),
    status: (run.reviewStatus ?? AnalysisReviewStatus.EDITING).toLowerCase() as AnalysisReviewState['status'],
    computed_revision: run.reviewComputedRevision?.toString() ?? null,
    approved_revision: run.reviewApprovedRevision?.toString() ?? null,
    ball_corrections: ball.map(item => item.visible
      ? { frame_index: item.frameIndex.toString(), state: 'position' as const, frame_pos: { x: item.frameX!, y: item.frameY! }, revision: item.revision.toString() }
      : { frame_index: item.frameIndex.toString(), state: 'missing' as const, frame_pos: null, revision: item.revision.toString() }),
    action_corrections: action.map(item => ({ frame_index: item.frameIndex.toString(), track_id: item.trackId, action: item.action as AnalysisReviewState['action_corrections'][number]['action'], revision: item.revision.toString() })),
    player_bbox_corrections: bbox.map(item => ({ frame_index: item.frameIndex.toString(), track_id: item.trackId, frame_bbox: { x1: item.frameX1, y1: item.frameY1, x2: item.frameX2, y2: item.frameY2 }, revision: item.revision.toString() })),
    contact_actor_corrections: contactActor.map(item => ({ key_point_id: item.keyPointId, track_id: item.trackId, revision: item.revision.toString() })),
    contact_time_corrections: contactTime.map(item => ({ key_point_id: item.keyPointId, frame_index: item.frameIndex.toString(), revision: item.revision.toString() })),
    contact_edits: contactEdits.map(item => ({ contact_id: item.contactId, base_key_point_id: item.baseKeyPointId, frame_index: item.frameIndex.toString(), track_id: item.trackId, deleted: item.deleted, revision: item.revision.toString() })),
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
  if (!run || !run.analysisDataManifest) throw new AnalysisReviewError('NOT_FOUND', 'analysis review is unavailable')
  const totalFrames = run.analysisDataManifest.totalFrames
  const tracks = new Map(run.tracks.map(track => [track.trackId, track]))
  const contacts = new Map(run.contactEvents.map(event => [event.keyPointId, event]))
  const runContactEdits = run.contactEdits ?? []
  const contactEdits = new Map(runContactEdits.map(edit => [edit.contactId, edit]))
  const existingContactTimeCorrections = await database.analysisContactTimeCorrection.findMany({
    where: { analysisRunId: input.analysisRunId },
    select: { keyPointId: true, frameIndex: true },
  })
  const effectiveContactFrames = new Map(run.contactEvents.map(event => [event.keyPointId, event.resolvedFrameIndex ?? event.anchorFrameIndex]))
  for (const edit of runContactEdits) effectiveContactFrames.set(edit.contactId, edit.frameIndex)
  for (const correction of existingContactTimeCorrections) effectiveContactFrames.set(correction.keyPointId, correction.frameIndex)
  const assertFrame = (frameIndex: bigint) => {
    if (frameIndex >= totalFrames) throw new AnalysisReviewError('FRAME_OUT_OF_RANGE', 'frame is outside AnalysisData')
  }
  const assertTrack = (trackId: number, frameIndex: bigint) => {
    const track = tracks.get(trackId)
    if (!track || frameIndex < track.firstFrame || frameIndex > track.lastFrame) {
      throw new AnalysisReviewError('TRACK_NOT_ACTIVE', 'track is not active on this frame')
    }
  }
  for (const operation of input.patch.operations) {
    if (operation.op !== 'set_contact_time' && operation.op !== 'clear_contact_time_override') continue
    const contact = contacts.get(operation.key_point_id)
    const contactEdit = contactEdits.get(operation.key_point_id)
    if (!contact && !contactEdit) throw new AnalysisReviewError('NOT_FOUND', 'contact event is unavailable')
    if (contact && contact.anchorOrigin !== 'ai_detected') throw new AnalysisReviewError('NOT_FOUND', 'only AI-detected or manually added contact time can be changed')
    const frameIndex = operation.op === 'set_contact_time'
      ? BigInt(operation.frame_index)
      : contactEdit && !contact
        ? contactEdit.frameIndex
        : (contact!.resolvedFrameIndex ?? contact!.anchorFrameIndex)
    assertFrame(frameIndex)
    effectiveContactFrames.set(operation.key_point_id, frameIndex)
  }
  const orderedBaseFrames = run.contactEvents.map(event => effectiveContactFrames.get(event.keyPointId)!)
  if (orderedBaseFrames.some((frame, index) => index > 0 && frame <= orderedBaseFrames[index - 1]!)) {
    throw new AnalysisReviewError('FRAME_OUT_OF_RANGE', 'contact time must remain strictly ordered between neighboring events')
  }
  for (const operation of input.patch.operations) {
    if (operation.op === 'add_contact') {
      if (contacts.has(operation.contact_id) || contactEdits.has(operation.contact_id)) throw new AnalysisReviewError('NOT_FOUND', 'contact id already exists')
      const frameIndex = BigInt(operation.frame_index)
      assertFrame(frameIndex)
      if (operation.track_id !== null) assertTrack(operation.track_id, frameIndex)
      continue
    }
    if (operation.op === 'delete_contact' || operation.op === 'restore_contact') {
      if (!contacts.has(operation.contact_id) && !contactEdits.has(operation.contact_id)) throw new AnalysisReviewError('NOT_FOUND', 'contact event is unavailable')
      continue
    }
    if (operation.op === 'set_contact_actor' || operation.op === 'clear_contact_actor_override') {
      const contact = contacts.get(operation.key_point_id)
      const contactEdit = contactEdits.get(operation.key_point_id)
      if (!contact && !contactEdit) throw new AnalysisReviewError('NOT_FOUND', 'contact event is unavailable')
      if (operation.op === 'set_contact_actor' && operation.track_id !== null) {
        assertTrack(operation.track_id, effectiveContactFrames.get(operation.key_point_id)!)
      }
      continue
    }
    if (operation.op === 'set_contact_time' || operation.op === 'clear_contact_time_override') {
      continue
    }
    const frameIndex = BigInt(operation.frame_index)
    assertFrame(frameIndex)
    if (operation.op === 'set_ball_position') {
      if (operation.frame_pos.x > run.analysisDataManifest.videoWidth || operation.frame_pos.y > run.analysisDataManifest.videoHeight) {
        throw new AnalysisReviewError('FRAME_OUT_OF_RANGE', 'ball position is outside the video frame')
      }
      continue
    }
    if (operation.op === 'mark_ball_missing' || operation.op === 'clear_ball_override') continue
    assertTrack(operation.track_id, frameIndex)
    if (operation.op === 'set_player_bbox') {
      const bbox = operation.frame_bbox
      if (bbox.x2 > run.analysisDataManifest.videoWidth || bbox.y2 > run.analysisDataManifest.videoHeight) {
        throw new AnalysisReviewError('FRAME_OUT_OF_RANGE', 'player box is outside the video frame')
      }
    }
  }

  const result = await database.$transaction(async (tx) => {
    const duplicate = await tx.analysisReviewPatchReceipt.findUnique({ where: { id: input.patch.client_patch_id } })
    if (duplicate) return { revision: duplicate.revision, duplicate: true, rebased: false }
    const before = await tx.analysisRun.findUniqueOrThrow({ where: { id: input.analysisRunId }, select: { reviewRevision: true } })
    const updated = await tx.analysisRun.update({
      where: { id: input.analysisRunId },
      data: {
        reviewRevision: { increment: 1 },
        reviewStatus: AnalysisReviewStatus.EDITING,
        reviewComputedRevision: null,
        reviewComputedAt: null,
        reviewApprovedRevision: null,
        reviewApprovedAt: null,
        reviewApprovedByUserId: null,
      },
      select: { reviewRevision: true },
    })
    for (const operation of input.patch.operations) {
      if (operation.op === 'add_contact') {
        await tx.analysisContactEdit.create({ data: { analysisRunId: input.analysisRunId, contactId: operation.contact_id, baseKeyPointId: null, frameIndex: BigInt(operation.frame_index), trackId: operation.track_id, deleted: false, revision: updated.reviewRevision, updatedByUserId: input.identity.userId } })
        continue
      }
      if (operation.op === 'delete_contact') {
        const base = contacts.get(operation.contact_id)
        const existing = contactEdits.get(operation.contact_id)
        await tx.analysisContactEdit.upsert({
          where: { analysisRunId_contactId: { analysisRunId: input.analysisRunId, contactId: operation.contact_id } },
          create: { analysisRunId: input.analysisRunId, contactId: operation.contact_id, baseKeyPointId: base?.keyPointId ?? null, frameIndex: effectiveContactFrames.get(operation.contact_id)!, trackId: base?.actors[0]?.trackId ?? null, deleted: true, revision: updated.reviewRevision, updatedByUserId: input.identity.userId },
          update: { deleted: true, frameIndex: existing?.frameIndex ?? effectiveContactFrames.get(operation.contact_id)!, revision: updated.reviewRevision, updatedByUserId: input.identity.userId },
        })
        continue
      }
      if (operation.op === 'restore_contact') {
        const existing = contactEdits.get(operation.contact_id)
        if (existing?.baseKeyPointId) await tx.analysisContactEdit.deleteMany({ where: { analysisRunId: input.analysisRunId, contactId: operation.contact_id } })
        else await tx.analysisContactEdit.updateMany({ where: { analysisRunId: input.analysisRunId, contactId: operation.contact_id }, data: { deleted: false, revision: updated.reviewRevision, updatedByUserId: input.identity.userId } })
        continue
      }
      if (operation.op === 'set_contact_actor') {
        const manual = contactEdits.get(operation.key_point_id)
        if (manual && !manual.baseKeyPointId) {
          await tx.analysisContactEdit.update({ where: { analysisRunId_contactId: { analysisRunId: input.analysisRunId, contactId: operation.key_point_id } }, data: { trackId: operation.track_id, revision: updated.reviewRevision, updatedByUserId: input.identity.userId } })
          continue
        }
        await tx.analysisContactActorCorrection.upsert({
          where: { analysisRunId_keyPointId: { analysisRunId: input.analysisRunId, keyPointId: operation.key_point_id } },
          create: { analysisRunId: input.analysisRunId, keyPointId: operation.key_point_id, trackId: operation.track_id, revision: updated.reviewRevision, updatedByUserId: input.identity.userId },
          update: { trackId: operation.track_id, revision: updated.reviewRevision, updatedByUserId: input.identity.userId },
        })
        continue
      }
      if (operation.op === 'clear_contact_actor_override') {
        const manual = contactEdits.get(operation.key_point_id)
        if (manual && !manual.baseKeyPointId) {
          await tx.analysisContactEdit.update({ where: { analysisRunId_contactId: { analysisRunId: input.analysisRunId, contactId: operation.key_point_id } }, data: { trackId: null, revision: updated.reviewRevision, updatedByUserId: input.identity.userId } })
          continue
        }
        await tx.analysisContactActorCorrection.deleteMany({ where: { analysisRunId: input.analysisRunId, keyPointId: operation.key_point_id } })
        continue
      }
      if (operation.op === 'set_contact_time') {
        const manual = contactEdits.get(operation.key_point_id)
        if (manual && !manual.baseKeyPointId) {
          await tx.analysisContactEdit.update({ where: { analysisRunId_contactId: { analysisRunId: input.analysisRunId, contactId: operation.key_point_id } }, data: { frameIndex: BigInt(operation.frame_index), revision: updated.reviewRevision, updatedByUserId: input.identity.userId } })
          continue
        }
        await tx.analysisContactTimeCorrection.upsert({
          where: { analysisRunId_keyPointId: { analysisRunId: input.analysisRunId, keyPointId: operation.key_point_id } },
          create: { analysisRunId: input.analysisRunId, keyPointId: operation.key_point_id, frameIndex: BigInt(operation.frame_index), revision: updated.reviewRevision, updatedByUserId: input.identity.userId },
          update: { frameIndex: BigInt(operation.frame_index), revision: updated.reviewRevision, updatedByUserId: input.identity.userId },
        })
        continue
      }
      if (operation.op === 'clear_contact_time_override') {
        const manual = contactEdits.get(operation.key_point_id)
        if (manual && !manual.baseKeyPointId) continue
        await tx.analysisContactTimeCorrection.deleteMany({ where: { analysisRunId: input.analysisRunId, keyPointId: operation.key_point_id } })
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

export async function recalculateAnalysisReview(
  database: PrismaClient,
  input: { analysisRunId: string; identity: ReviewIdentity },
) {
  if (!WRITE_ROLES.has(input.identity.role)) throw new AnalysisReviewError('FORBIDDEN', 'analysis review is read-only for this role')
  const run = await authorizedRun(database, input.analysisRunId, input.identity)
  if (!run) throw new AnalysisReviewError('NOT_FOUND', 'analysis review is unavailable')
  const activeContacts = run.contactEvents.length
    + (run.contactEdits ?? []).filter(edit => !edit.baseKeyPointId && !edit.deleted).length
    - (run.contactEdits ?? []).filter(edit => edit.baseKeyPointId && edit.deleted).length
  const updated = await database.analysisRun.update({
    where: { id: input.analysisRunId },
    data: { reviewStatus: AnalysisReviewStatus.READY, reviewComputedRevision: run.reviewRevision, reviewComputedAt: new Date(), reviewApprovedRevision: null, reviewApprovedAt: null, reviewApprovedByUserId: null },
    select: { reviewRevision: true, reviewStatus: true, reviewComputedAt: true },
  })
  return { schema_version: ANALYSIS_REVIEW_SCHEMA_VERSION, analysis_run_id: input.analysisRunId, revision: updated.reviewRevision.toString(), status: updated.reviewStatus.toLowerCase(), contact_count: Math.max(0, activeContacts), computed_at: updated.reviewComputedAt!.toISOString() }
}

export async function approveAnalysisReview(
  database: PrismaClient,
  input: { analysisRunId: string; identity: ReviewIdentity },
) {
  if (!WRITE_ROLES.has(input.identity.role)) throw new AnalysisReviewError('FORBIDDEN', 'analysis review is read-only for this role')
  const run = await authorizedRun(database, input.analysisRunId, input.identity)
  if (!run) throw new AnalysisReviewError('NOT_FOUND', 'analysis review is unavailable')
  if (run.reviewStatus !== AnalysisReviewStatus.READY || run.reviewComputedRevision !== run.reviewRevision) {
    throw new AnalysisReviewError('REVIEW_NOT_READY', 'apply changes and recalculate before approving this clip')
  }
  const updated = await database.analysisRun.update({
    where: { id: input.analysisRunId },
    data: { reviewStatus: AnalysisReviewStatus.APPROVED, reviewApprovedRevision: run.reviewRevision, reviewApprovedAt: new Date(), reviewApprovedByUserId: input.identity.userId },
    select: { reviewRevision: true, reviewStatus: true, reviewApprovedAt: true },
  })
  return { schema_version: ANALYSIS_REVIEW_SCHEMA_VERSION, analysis_run_id: input.analysisRunId, revision: updated.reviewRevision.toString(), status: updated.reviewStatus.toLowerCase(), approved_at: updated.reviewApprovedAt!.toISOString() }
}
