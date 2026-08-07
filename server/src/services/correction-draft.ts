import { createHash } from 'node:crypto'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { Prisma, UserRole } from '@volleyball-monitoring/db/client'

const SERIALIZABLE_RETRIES = 3
const CORRECTION_ROLES = new Set<UserRole>([
  UserRole.ADMIN,
  UserRole.OPERATOR,
  UserRole.ANNOTATOR,
])

export type CorrectionDraftErrorCode =
  | 'ACTIVE_RALLY_EXISTS'
  | 'FORBIDDEN'
  | 'INVALID_SUBMISSION_STATE'
  | 'NOT_FOUND'
  | 'UNAUTHENTICATED'

export class CorrectionDraftError extends Error {
  constructor(public readonly code: CorrectionDraftErrorCode, message: string) {
    super(message)
    this.name = 'CorrectionDraftError'
  }
}

export interface CorrectionDraftIdentity {
  deviceSessionId: string
  role: UserRole
  userId: string
}

export interface CorrectionDraftResult {
  annotation_status: 'ready'
  rally_id: string
  revision: string
  score_resolution: 'resolved' | 'unknown'
  scoring_court_side: 'left' | 'right' | null
  supersedes_submission_id: string
}

function isRetryable(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034'
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

export async function createCorrectionDraft(
  database: PrismaClient,
  submissionId: string,
  identity: CorrectionDraftIdentity,
): Promise<CorrectionDraftResult> {
  if (!CORRECTION_ROLES.has(identity.role)) {
    throw new CorrectionDraftError('FORBIDDEN', 'Correction drafts require annotation access')
  }

  let failure: unknown
  for (let attempt = 0; attempt < SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await database.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`annotation-correction:${submissionId}`}, 0))::text AS lock`

        const device = await tx.deviceSession.findFirst({
          where: { id: identity.deviceSessionId, revokedAt: null, userId: identity.userId },
          select: { id: true },
        })
        if (!device) throw new CorrectionDraftError('UNAUTHENTICATED', 'Authenticated device session is not active')

        const submission = await tx.rallySubmission.findUnique({
          where: { id: submissionId },
          include: {
            keyPoints: { orderBy: [{ sequenceIndex: 'asc' }, { id: 'asc' }] },
            rally: { include: { keyPoints: true } },
          },
        })
        if (!submission) throw new CorrectionDraftError('NOT_FOUND', 'Submission was not found')

        const rally = submission.rally
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`annotation-rally:${rally.id}`}, 0))::text AS lock`
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`annotation-set:${rally.setId}`}, 0))::text AS lock`

        const authorized = identity.role === UserRole.ADMIN || await tx.matchMember.findFirst({
          where: {
            matchId: rally.matchId,
            userId: identity.userId,
            role: { in: [UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR] },
          },
          select: { userId: true },
        })
        if (!authorized) throw new CorrectionDraftError('FORBIDDEN', 'Submission is outside the current annotation scope')
        if (
          submission.status !== 'ACTIVE'
          || rally.activeSubmissionId !== submission.id
          || rally.annotationStatus !== 'SUBMITTED'
          || rally.voidedAt !== null
        ) {
          throw new CorrectionDraftError('INVALID_SUBMISSION_STATE', 'Only the active immutable submission can open a correction draft')
        }

        const competing = await tx.rally.findFirst({
          where: {
            id: { not: rally.id },
            setId: rally.setId,
            voidedAt: null,
            annotationStatus: { in: ['OPEN', 'READY'] },
          },
          select: { id: true },
        })
        if (competing) {
          throw new CorrectionDraftError('ACTIVE_RALLY_EXISTS', 'Finish or void the current draft before correcting a submitted Rally')
        }

        const revision = rally.annotationRevision + 1n
        const now = new Date()
        const snapshotIds = new Set(submission.keyPoints.map(point => point.sourceDraftKeyPointId))
        const temporaryBase = Math.min(
          -1,
          ...rally.keyPoints.map(point => point.sequenceIndex - rally.keyPoints.length - 1),
        )

        for (const [index, point] of rally.keyPoints.entries()) {
          await tx.keyPoint.update({
            where: { id: point.id },
            data: {
              deletedAt: now,
              isTerminal: false,
              sequenceIndex: temporaryBase - index,
              updatedByUserId: identity.userId,
            },
          })
        }

        for (const point of submission.keyPoints) {
          const originalPlaybackCursor = json({
            source: 'immutable_submission_correction',
            submission_id: submission.id,
            submission_key_point_id: point.id,
          })
          const existing = rally.keyPoints.find(candidate => candidate.id === point.sourceDraftKeyPointId)
          const possibleDuplicate = point.markerKind === 'CONTACT'
            && submission.keyPoints.filter(candidate => candidate.markerKind === 'CONTACT' && candidate.captureFrameIndex === point.captureFrameIndex).length > 1
          const data = {
            captureEpochId: point.captureEpochId,
            captureFrameIndex: point.captureFrameIndex,
            captureTimeUs: point.captureTimeUs,
            deletedAt: null,
            deviceSessionId: identity.deviceSessionId,
            isTerminal: point.isTerminal,
            markerKind: point.markerKind,
            originalPlaybackCursor,
            possibleDuplicate,
            sequenceIndex: point.sequenceIndex,
            snapDistanceUs: null,
            sourcePts: point.sourcePts,
            timingPrecision: point.timingPrecision,
            updatedByUserId: identity.userId,
          } as const

          if (existing) {
            await tx.keyPoint.update({ where: { id: existing.id }, data })
          }
          else {
            await tx.keyPoint.create({
              data: {
                ...data,
                createdByUserId: identity.userId,
                id: point.sourceDraftKeyPointId,
                rallyId: rally.id,
              },
            })
          }
        }

        for (const point of rally.keyPoints) {
          if (!snapshotIds.has(point.id)) {
            await tx.keyPoint.update({
              where: { id: point.id },
              data: { deletedAt: now, updatedByUserId: identity.userId },
            })
          }
        }

        const changed = await tx.rally.updateMany({
          where: {
            id: rally.id,
            activeSubmissionId: submission.id,
            annotationRevision: rally.annotationRevision,
            annotationStatus: 'SUBMITTED',
          },
          data: {
            annotationRevision: revision,
            annotationStatus: 'READY',
            scoreResolutionState: submission.scoreResolutionState,
            scoringCourtSide: submission.scoringCourtSide,
            scoringTeamId: submission.scoringTeamId,
            leftScoreBefore: submission.leftScoreBefore,
            rightScoreBefore: submission.rightScoreBefore,
            leftScoreAfter: submission.leftScoreAfter,
            rightScoreAfter: submission.rightScoreAfter,
          },
        })
        if (changed.count !== 1) throw new CorrectionDraftError('INVALID_SUBMISSION_STATE', 'Submission changed while opening correction draft')

        const auditPayload = {
          source_submission_id: submission.id,
          restored_key_point_count: submission.keyPoints.length,
        }
        await tx.annotationOperation.create({
          data: {
            baseRevision: rally.annotationRevision,
            clientMutationId: `correction-draft:${submission.id}:${revision}`,
            deviceSessionId: identity.deviceSessionId,
            operationKind: 'CREATE_CORRECTION_DRAFT',
            payload: json(auditPayload),
            payloadHash: createHash('sha256').update(JSON.stringify(auditPayload)).digest('hex'),
            rallyId: rally.id,
            resultRevision: revision,
            userId: identity.userId,
          },
        })
        await tx.outboxEvent.create({
          data: {
            aggregateId: rally.id,
            aggregateType: 'Rally',
            dedupeKey: `correction-draft:${submission.id}:${revision}`,
            eventType: 'annotation.correction_draft_created.v1',
            payload: json({
              rally_id: rally.id,
              revision: revision.toString(),
              supersedes_submission_id: submission.id,
            }),
          },
        })

        return {
          annotation_status: 'ready',
          rally_id: rally.id,
          revision: revision.toString(),
          score_resolution: submission.scoreResolutionState.toLowerCase() as 'resolved' | 'unknown',
          scoring_court_side: submission.scoringCourtSide?.toLowerCase() as 'left' | 'right' | undefined ?? null,
          supersedes_submission_id: submission.id,
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    }
    catch (error) {
      failure = error
      if (!isRetryable(error)) throw error
    }
  }
  throw failure
}
