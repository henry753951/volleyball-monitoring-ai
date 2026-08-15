import { createHash, randomUUID } from 'node:crypto'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { JobStatus, Prisma, ProcessingStatus, UserRole } from '@volleyball-monitoring/db/client'

const ALLOWED_ROLES = new Set<UserRole>([UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR])
const CANCELLABLE = new Set<ProcessingStatus>([
  ProcessingStatus.CLIP_QUEUED,
  ProcessingStatus.CLIPPING,
  ProcessingStatus.AI_QUEUED,
  ProcessingStatus.AI_PROCESSING,
  ProcessingStatus.ARTIFACT_INGESTING,
])

export type ProcessingCancellationErrorCode =
  | 'FORBIDDEN'
  | 'INVALID_PROCESSING_STATE'
  | 'NOT_FOUND'
  | 'SCORE_CONFLICT'
  | 'UNAUTHENTICATED'

export class ProcessingCancellationError extends Error {
  constructor(
    public readonly code: ProcessingCancellationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ProcessingCancellationError'
  }
}

export interface ProcessingCancellationIdentity {
  deviceSessionId: string
  role: UserRole
  userId: string
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

export async function cancelProcessingRally(
  database: PrismaClient,
  rallyId: string,
  identity: ProcessingCancellationIdentity,
) {
  if (!ALLOWED_ROLES.has(identity.role)) {
    throw new ProcessingCancellationError(
      'FORBIDDEN',
      'Processing cancellation requires annotation access',
    )
  }
  return database.$transaction(
    async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`processing-cancel:${rallyId}`}, 0))::text AS lock`
      const device = await tx.deviceSession.findFirst({
        where: { id: identity.deviceSessionId, userId: identity.userId, revokedAt: null },
        select: { id: true },
      })
      if (!device)
        throw new ProcessingCancellationError(
          'UNAUTHENTICATED',
          'Authenticated device session is not active',
        )

      const rally = await tx.rally.findUnique({
        where: { id: rallyId },
        include: {
          activeSubmission: {
            include: {
              keyPoints: { orderBy: [{ sequenceIndex: 'asc' }, { id: 'asc' }] },
              aiJobs: true,
              clipJobs: true,
              scoreLedgerEntries: { orderBy: { scoreRevisionAfter: 'desc' }, take: 1 },
              supersedes: true,
            },
          },
          set: { select: { id: true, leftScore: true, rightScore: true, scoreRevision: true } },
        },
      })
      if (!rally || rally.voidedAt)
        throw new ProcessingCancellationError('NOT_FOUND', 'Processing rally was not found')
      const authorized =
        identity.role === UserRole.ADMIN ||
        (await tx.matchMember.findFirst({
          where: {
            matchId: rally.matchId,
            userId: identity.userId,
            role: { in: [...ALLOWED_ROLES] },
          },
          select: { userId: true },
        }))
      if (!authorized)
        throw new ProcessingCancellationError(
          'FORBIDDEN',
          'Rally is outside the current annotation scope',
        )
      if (!CANCELLABLE.has(rally.processingStatus) || !rally.activeSubmission) {
        throw new ProcessingCancellationError(
          'INVALID_PROCESSING_STATE',
          'Only an active processing rally can be deleted',
        )
      }

      const source = rally.activeSubmission
      await tx.$queryRaw`SELECT id FROM "ClipJob" WHERE "submissionId" = ${source.id}::uuid FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM "AiJob" WHERE "submissionId" = ${source.id}::uuid FOR UPDATE`
      const currentState = await tx.rally.findUnique({
        where: { id: rally.id },
        select: { processingStatus: true, voidedAt: true },
      })
      if (
        !currentState ||
        currentState.voidedAt ||
        !CANCELLABLE.has(currentState.processingStatus)
      ) {
        throw new ProcessingCancellationError(
          'INVALID_PROCESSING_STATE',
          'Processing completed before cancellation could be committed',
        )
      }
      if (
        source.supersedesSubmissionId &&
        (!source.supersedes ||
          source.supersedes.status !== 'SUPERSEDED' ||
          source.supersedes.rallyId !== rally.id)
      ) {
        throw new ProcessingCancellationError(
          'INVALID_PROCESSING_STATE',
          'Correction source cannot be restored safely',
        )
      }
      const restored = source.supersedes
      const sourceLedger = source.scoreLedgerEntries[0]
      const leftDelta = -(sourceLedger?.leftDelta ?? 0)
      const rightDelta = -(sourceLedger?.rightDelta ?? 0)
      const scoreChanged = leftDelta !== 0 || rightDelta !== 0
      const scoreAfter = {
        left: rally.set.leftScore + leftDelta,
        right: rally.set.rightScore + rightDelta,
        revision: rally.set.scoreRevision + (scoreChanged ? 1 : 0),
      }
      if (scoreAfter.left < 0 || scoreAfter.right < 0) {
        throw new ProcessingCancellationError(
          'SCORE_CONFLICT',
          'Score reversal would produce a negative score',
        )
      }

      const now = new Date()
      const cancellationSubmissionId = randomUUID()
      const cancellationRevision = rally.annotationRevision + 1n
      const contentHash = createHash('sha256')
        .update(`cancel:${source.id}:${cancellationRevision}`)
        .digest('hex')
      await tx.rallySubmission.create({
        data: {
          id: cancellationSubmissionId,
          rallyId: rally.id,
          annotationRevision: cancellationRevision,
          contentHash,
          status: 'CANCELLED',
          scoreResolutionState: 'UNKNOWN',
          scoringCourtSide: null,
          scoringTeamId: null,
          leftTeamId: source.leftTeamId,
          rightTeamId: source.rightTeamId,
          sideAssignmentId: source.sideAssignmentId,
          sideAssignmentReversed: source.sideAssignmentReversed,
          leftScoreBefore: scoreChanged ? rally.set.leftScore : null,
          rightScoreBefore: scoreChanged ? rally.set.rightScore : null,
          leftScoreAfter: scoreChanged ? scoreAfter.left : null,
          rightScoreAfter: scoreChanged ? scoreAfter.right : null,
          scoreRevisionBefore: scoreChanged ? rally.set.scoreRevision : null,
          scoreRevisionAfter: scoreChanged ? scoreAfter.revision : null,
          clipPolicyVersion: source.clipPolicyVersion,
          clipPreRollUs: source.clipPreRollUs,
          clipPostRollUs: source.clipPostRollUs,
          submittedByUserId: identity.userId,
          supersedesSubmissionId: source.id,
          submittedAt: now,
        },
      })
      const copiedPoints = source.keyPoints.map(point => ({
        id: randomUUID(),
        submissionId: cancellationSubmissionId,
        captureEpochId: point.captureEpochId,
        sourceDraftKeyPointId: point.sourceDraftKeyPointId,
        sequenceIndex: point.sequenceIndex,
        markerKind: point.markerKind,
        isTerminal: point.isTerminal,
        sourcePts: point.sourcePts,
        captureTimeUs: point.captureTimeUs,
        captureFrameIndex: point.captureFrameIndex,
        timingPrecision: point.timingPrecision,
      }))
      await tx.rallySubmissionKeyPoint.createMany({ data: copiedPoints })
      await tx.rallySubmission.update({
        where: { id: cancellationSubmissionId },
        data: {
          serviceKeyPointId: copiedPoints.find(point => point.markerKind === 'SERVICE')?.id ?? null,
          terminalKeyPointId: copiedPoints.find(point => point.isTerminal)?.id ?? null,
        },
      })

      if (scoreChanged) {
        const updated = await tx.matchSet.updateMany({
          where: { id: rally.set.id, scoreRevision: rally.set.scoreRevision },
          data: {
            leftScore: scoreAfter.left,
            rightScore: scoreAfter.right,
            scoreRevision: scoreAfter.revision,
          },
        })
        if (updated.count !== 1)
          throw new ProcessingCancellationError(
            'SCORE_CONFLICT',
            'Set score changed while cancelling rally',
          )
        await tx.scoreLedgerEntry.create({
          data: {
            kind: 'CORRECTION',
            setId: rally.set.id,
            submissionId: cancellationSubmissionId,
            supersededSubmissionId: source.id,
            leftDelta,
            rightDelta,
            leftScoreBefore: rally.set.leftScore,
            rightScoreBefore: rally.set.rightScore,
            leftScoreAfter: scoreAfter.left,
            rightScoreAfter: scoreAfter.right,
            scoreRevisionBefore: rally.set.scoreRevision,
            scoreRevisionAfter: scoreAfter.revision,
          },
        })
      }

      await tx.rallySubmission.update({ where: { id: source.id }, data: { status: 'SUPERSEDED' } })
      if (restored)
        await tx.rallySubmission.update({ where: { id: restored.id }, data: { status: 'ACTIVE' } })
      await tx.clipJob.updateMany({
        where: { submissionId: source.id, status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] } },
        data: {
          status: JobStatus.CANCELLED,
          leasedUntil: null,
          completedAt: now,
          errorCode: 'PROCESSING_CANCELLED',
          errorMessage: 'processing rally deleted by annotator',
        },
      })
      await tx.aiJob.updateMany({
        where: { submissionId: source.id, status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] } },
        data: {
          status: JobStatus.CANCELLED,
          cancelRequestedAt: now,
          leasedUntil: null,
          completedAt: now,
          callbackTokenExpiresAt: now,
          errorCode: 'PROCESSING_CANCELLED',
          errorMessage: 'processing rally deleted by annotator',
        },
      })
      await tx.analysisRun.updateMany({
        where: { submissionId: source.id, status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] } },
        data: { status: JobStatus.CANCELLED },
      })
      await tx.rally.update({
        where: { id: rally.id },
        data: {
          activeSubmissionId: restored?.id ?? null,
          annotationRevision: cancellationRevision,
          processingStatus: restored ? ProcessingStatus.COMPLETED : ProcessingStatus.CANCELLED,
          voidedAt: restored ? null : now,
          scoreResolutionState: restored?.scoreResolutionState ?? rally.scoreResolutionState,
          scoringCourtSide: restored?.scoringCourtSide ?? rally.scoringCourtSide,
          scoringTeamId: restored?.scoringTeamId ?? rally.scoringTeamId,
          sideAssignmentReversed: restored?.sideAssignmentReversed ?? rally.sideAssignmentReversed,
          leftScoreAfter: scoreChanged ? scoreAfter.left : rally.leftScoreAfter,
          rightScoreAfter: scoreChanged ? scoreAfter.right : rally.rightScoreAfter,
        },
      })
      for (const aiJob of source.aiJobs) {
        await tx.outboxEvent.create({
          data: {
            aggregateType: 'AiJob',
            aggregateId: aiJob.id,
            eventType: 'ai.job_abort_requested.v1',
            dedupeKey: `ai-abort:${aiJob.id}`,
            payload: json({
              ai_job_id: aiJob.id,
              rally_id: rally.id,
              reason: 'processing_rally_deleted',
            }),
          },
        })
      }
      await tx.outboxEvent.create({
        data: {
          aggregateType: 'Rally',
          aggregateId: rally.id,
          eventType: 'rally.processing_cancelled.v1',
          dedupeKey: `rally-processing-cancelled:${rally.id}:${cancellationRevision}`,
          payload: json({
            cancellation_submission_id: cancellationSubmissionId,
            cancelled_submission_id: source.id,
            cancelled_by_user_id: identity.userId,
            rally_id: rally.id,
            score_revision_after: scoreAfter.revision,
          }),
        },
      })
      return { rally_id: rally.id, cancellation_submission_id: cancellationSubmissionId }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  )
}
