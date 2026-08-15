import { createHash, randomUUID } from 'node:crypto'
import type { PrismaClient } from '@volleyball-monitoring/db'
import { Prisma, UserRole } from '@volleyball-monitoring/db/client'
import { readClipFrameTimeline, timingManifestIdentity } from '../media/clip-timing-coverage.js'
import type { MediaObjectReader } from '../media/playback-domain.js'

const SERIALIZABLE_RETRIES = 3
const CORRECTION_ROLES = new Set<UserRole>([UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR])

export type CorrectionDraftErrorCode =
  | 'ACTIVE_RALLY_EXISTS'
  | 'FORBIDDEN'
  | 'INVALID_SUBMISSION_STATE'
  | 'NOT_FOUND'
  | 'UNAUTHENTICATED'

export class CorrectionDraftError extends Error {
  constructor(
    public readonly code: CorrectionDraftErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CorrectionDraftError'
  }
}

export interface CorrectionDraftIdentity {
  deviceSessionId: string
  role: UserRole
  userId: string
}

export interface CorrectionDraftOptions {
  preserveAnalysisContacts?: boolean
  regenerateAnalysisContacts?: boolean
  reverseCourtSides?: boolean
  timingManifestReader?: MediaObjectReader
}

export interface CorrectionDraftResult {
  annotation_status: 'open'
  rally_id: string
  revision: string
  score_resolution: 'pending' | 'resolved' | 'unknown'
  scoring_court_side: 'left' | 'right' | null
  supersedes_submission_id: string
}

export interface CancelCorrectionDraftResult {
  annotation_status: 'submitted'
  rally_id: string
  revision: string
  active_submission_id: string
}

function isRetryable(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034'
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

interface PreservedContactAnchor {
  captureEpochId: string
  captureFrameIndex: bigint
  captureTimeUs: bigint
  contactId: string
  sourcePts: bigint
}

async function preservedContactAnchors(
  tx: Prisma.TransactionClient,
  submissionId: string,
  reader: MediaObjectReader | undefined,
): Promise<PreservedContactAnchor[]> {
  if (!reader)
    throw new CorrectionDraftError(
      'INVALID_SUBMISSION_STATE',
      'Timing manifest access is required to preserve reviewed key points',
    )
  const analysis = await tx.analysisRun.findFirst({
    where: { submissionId, status: 'COMPLETED' },
    orderBy: [{ activatedAt: 'desc' }, { createdAt: 'desc' }],
    select: {
      contactEvents: { select: { anchorFrameIndex: true, keyPointId: true } },
      contactTimeCorrections: { select: { frameIndex: true, keyPointId: true } },
      contactEdits: {
        select: { baseKeyPointId: true, contactId: true, deleted: true, frameIndex: true },
      },
      aiJob: {
        select: {
          clipJob: {
            select: {
              id: true,
              idempotencyKey: true,
              timingManifest: {
                select: {
                  bucket: true,
                  objectKey: true,
                  contentType: true,
                  byteLength: true,
                  sha256: true,
                  internalSchemaVersion: true,
                },
              },
            },
          },
        },
      },
    },
  })
  const clip = analysis?.aiJob.clipJob
  if (!analysis || !clip?.timingManifest) {
    throw new CorrectionDraftError(
      'INVALID_SUBMISSION_STATE',
      'Completed analysis timing is unavailable',
    )
  }
  const timeline = await readClipFrameTimeline(
    reader,
    clip.timingManifest,
    timingManifestIdentity(clip.id, clip.idempotencyKey, clip.timingManifest.objectKey),
  )
  const timeById = new Map(
    analysis.contactTimeCorrections.map(item => [item.keyPointId, item.frameIndex]),
  )
  const editById = new Map(analysis.contactEdits.map(item => [item.contactId, item]))
  const effective = [
    ...analysis.contactEvents.flatMap(event => {
      if (editById.get(event.keyPointId)?.deleted) return []
      return [
        {
          contactId: event.keyPointId,
          frameIndex: timeById.get(event.keyPointId) ?? event.anchorFrameIndex,
        },
      ]
    }),
    ...analysis.contactEdits.flatMap(edit =>
      !edit.baseKeyPointId && !edit.deleted
        ? [
            {
              contactId: edit.contactId,
              frameIndex: timeById.get(edit.contactId) ?? edit.frameIndex,
            },
          ]
        : [],
    ),
  ].sort((left, right) =>
    left.frameIndex < right.frameIndex
      ? -1
      : left.frameIndex > right.frameIndex
        ? 1
        : left.contactId.localeCompare(right.contactId),
  )

  if (effective.length === 0) {
    throw new CorrectionDraftError(
      'INVALID_SUBMISSION_STATE',
      'There are no reviewed key points to preserve; choose automatic regeneration',
    )
  }

  return effective.map(contact => {
    if (
      contact.frameIndex < 0n ||
      contact.frameIndex >= BigInt(timeline.captureTimeUs.length) ||
      contact.frameIndex > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new CorrectionDraftError(
        'INVALID_SUBMISSION_STATE',
        'A reviewed key point is outside the canonical clip',
      )
    }
    const index = Number(contact.frameIndex)
    return {
      captureEpochId: timeline.captureEpochId[index]!,
      captureFrameIndex: timeline.captureFrameIndex[index]!,
      captureTimeUs: timeline.captureTimeUs[index]!,
      contactId: contact.contactId,
      sourcePts: timeline.sourcePts[index]!,
    }
  })
}

export async function createCorrectionDraft(
  database: PrismaClient,
  submissionId: string,
  identity: CorrectionDraftIdentity,
  options: CorrectionDraftOptions = {},
): Promise<CorrectionDraftResult> {
  if (options.preserveAnalysisContacts && options.regenerateAnalysisContacts) {
    throw new CorrectionDraftError(
      'INVALID_SUBMISSION_STATE',
      'Key points cannot be preserved and regenerated at the same time',
    )
  }
  if (!CORRECTION_ROLES.has(identity.role)) {
    throw new CorrectionDraftError('FORBIDDEN', 'Correction drafts require annotation access')
  }

  let failure: unknown
  for (let attempt = 0; attempt < SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await database.$transaction(
        async tx => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`annotation-correction:${submissionId}`}, 0))::text AS lock`

          const device = await tx.deviceSession.findFirst({
            where: { id: identity.deviceSessionId, revokedAt: null, userId: identity.userId },
            select: { id: true },
          })
          if (!device)
            throw new CorrectionDraftError(
              'UNAUTHENTICATED',
              'Authenticated device session is not active',
            )

          const submission = await tx.rallySubmission.findUnique({
            where: { id: submissionId },
            include: {
              boundaries: true,
              keyPoints: { orderBy: [{ sequenceIndex: 'asc' }, { id: 'asc' }] },
              rally: { include: { boundaries: true, keyPoints: true } },
            },
          })
          if (!submission) throw new CorrectionDraftError('NOT_FOUND', 'Submission was not found')

          const rally = submission.rally
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`annotation-rally:${rally.id}`}, 0))::text AS lock`
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`annotation-set:${rally.setId}`}, 0))::text AS lock`

          const authorized =
            identity.role === UserRole.ADMIN ||
            (await tx.matchMember.findFirst({
              where: {
                matchId: rally.matchId,
                userId: identity.userId,
                role: { in: [UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR] },
              },
              select: { userId: true },
            }))
          if (!authorized)
            throw new CorrectionDraftError(
              'FORBIDDEN',
              'Submission is outside the current annotation scope',
            )

          const existingCorrectionDraft =
            submission.status === 'ACTIVE' &&
            rally.activeSubmissionId === submission.id &&
            ['OPEN', 'READY'].includes(rally.annotationStatus) &&
            rally.voidedAt === null
          if (existingCorrectionDraft) {
            if (
              options.reverseCourtSides &&
              rally.sideAssignmentReversed === submission.sideAssignmentReversed
            ) {
              throw new CorrectionDraftError(
                'INVALID_SUBMISSION_STATE',
                'The existing correction draft does not contain a court-side reversal',
              )
            }
            return {
              annotation_status: 'open',
              rally_id: rally.id,
              revision: rally.annotationRevision.toString(),
              score_resolution: submission.scoreResolutionState.toLowerCase() as
                | 'pending'
                | 'resolved'
                | 'unknown',
              scoring_court_side:
                (submission.scoringCourtSide?.toLowerCase() as 'left' | 'right' | undefined) ??
                null,
              supersedes_submission_id: submission.id,
            }
          }

          if (
            submission.status !== 'ACTIVE' ||
            rally.activeSubmissionId !== submission.id ||
            rally.annotationStatus !== 'SUBMITTED' ||
            rally.voidedAt !== null
          ) {
            throw new CorrectionDraftError(
              'INVALID_SUBMISSION_STATE',
              'Only the active immutable submission can open a correction draft',
            )
          }

          const revision = rally.annotationRevision + 1n
          const now = new Date()
          const sideAssignmentReversed = options.reverseCourtSides
            ? !submission.sideAssignmentReversed
            : submission.sideAssignmentReversed
          const effectiveLeftTeamId =
            sideAssignmentReversed === submission.sideAssignmentReversed
              ? submission.leftTeamId
              : submission.rightTeamId
          const effectiveRightTeamId =
            sideAssignmentReversed === submission.sideAssignmentReversed
              ? submission.rightTeamId
              : submission.leftTeamId
          const scoringTeamId =
            submission.scoreResolutionState === 'RESOLVED'
              ? submission.scoringCourtSide === 'LEFT'
                ? effectiveLeftTeamId
                : effectiveRightTeamId
              : null
          const preservedContacts = options.preserveAnalysisContacts
            ? await preservedContactAnchors(tx, submission.id, options.timingManifestReader)
            : null
          const fallbackStart = submission.keyPoints[0]
          const fallbackEnd = submission.keyPoints.at(-1)
          const restoresAnalysisContacts = Boolean(
            options.preserveAnalysisContacts || options.regenerateAnalysisContacts,
          )
          const restoredBoundaries =
            submission.boundaries.length > 0
              ? submission.boundaries
              : restoresAnalysisContacts &&
                  fallbackStart &&
                  fallbackEnd &&
                  fallbackStart.id !== fallbackEnd.id
                ? [
                    {
                      captureEpochId: fallbackStart.captureEpochId,
                      captureFrameIndex: fallbackStart.captureFrameIndex,
                      captureTimeUs: fallbackStart.captureTimeUs,
                      id: randomUUID(),
                      kind: 'START' as const,
                      sourceDraftBoundaryId: randomUUID(),
                      sourcePts: fallbackStart.sourcePts,
                      timingPrecision: fallbackStart.timingPrecision,
                    },
                    {
                      captureEpochId: fallbackEnd.captureEpochId,
                      captureFrameIndex: fallbackEnd.captureFrameIndex,
                      captureTimeUs: fallbackEnd.captureTimeUs,
                      id: randomUUID(),
                      kind: 'END' as const,
                      sourceDraftBoundaryId: randomUUID(),
                      sourcePts: fallbackEnd.sourcePts,
                      timingPrecision: fallbackEnd.timingPrecision,
                    },
                  ]
                : submission.boundaries
          if (restoresAnalysisContacts && restoredBoundaries.length !== 2) {
            throw new CorrectionDraftError(
              'INVALID_SUBMISSION_STATE',
              'The submitted segment does not have enough timing anchors for a correction',
            )
          }
          const snapshotIds = new Set<string>()
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

          for (const point of preservedContacts ?? []) {
            const id = randomUUID()
            snapshotIds.add(id)
            await tx.keyPoint.create({
              data: {
                captureEpochId: point.captureEpochId,
                captureFrameIndex: point.captureFrameIndex,
                captureTimeUs: point.captureTimeUs,
                createdByUserId: identity.userId,
                deletedAt: null,
                deviceSessionId: identity.deviceSessionId,
                id,
                isTerminal: false,
                markerKind: 'CONTACT',
                originalPlaybackCursor: json({
                  source: 'reviewed_analysis_correction',
                  analysis_contact_id: point.contactId,
                  submission_id: submission.id,
                }),
                possibleDuplicate: false,
                rallyId: rally.id,
                sequenceIndex: snapshotIds.size - 1,
                snapDistanceUs: null,
                sourcePts: point.sourcePts,
                timingPrecision: 'FRAME_EXACT',
                updatedByUserId: identity.userId,
              },
            })
          }

          for (const point of preservedContacts || options.regenerateAnalysisContacts
            ? []
            : submission.keyPoints) {
            snapshotIds.add(point.sourceDraftKeyPointId)
            const originalPlaybackCursor = json({
              source: 'immutable_submission_correction',
              submission_id: submission.id,
              submission_key_point_id: point.id,
            })
            const existing = rally.keyPoints.find(
              candidate => candidate.id === point.sourceDraftKeyPointId,
            )
            const possibleDuplicate =
              point.markerKind === 'CONTACT' &&
              submission.keyPoints.filter(
                candidate =>
                  candidate.markerKind === 'CONTACT' &&
                  candidate.captureFrameIndex === point.captureFrameIndex,
              ).length > 1
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
            } else {
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

          for (const boundary of restoredBoundaries) {
            const originalPlaybackCursor = json({
              source: 'immutable_submission_correction',
              submission_boundary_id: boundary.id,
              submission_id: submission.id,
            })
            const data = {
              captureEpochId: boundary.captureEpochId,
              captureFrameIndex: boundary.captureFrameIndex,
              captureTimeUs: boundary.captureTimeUs,
              deviceSessionId: identity.deviceSessionId,
              kind: boundary.kind,
              originalPlaybackCursor,
              snapDistanceUs: null,
              sourcePts: boundary.sourcePts,
              timingPrecision: boundary.timingPrecision,
              updatedByUserId: identity.userId,
            } as const
            const existing = rally.boundaries.find(candidate => candidate.kind === boundary.kind)
            if (existing) {
              await tx.rallyBoundary.update({ where: { id: existing.id }, data })
            } else {
              await tx.rallyBoundary.create({
                data: {
                  ...data,
                  createdByUserId: identity.userId,
                  id: boundary.sourceDraftBoundaryId,
                  rallyId: rally.id,
                },
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
              annotationStatus: 'OPEN',
              sideAssignmentReversed,
              scoreResolutionState: submission.scoreResolutionState,
              scoringCourtSide: submission.scoringCourtSide,
              scoringTeamId,
              leftScoreBefore: submission.leftScoreBefore,
              rightScoreBefore: submission.rightScoreBefore,
              leftScoreAfter: submission.leftScoreAfter,
              rightScoreAfter: submission.rightScoreAfter,
            },
          })
          if (changed.count !== 1)
            throw new CorrectionDraftError(
              'INVALID_SUBMISSION_STATE',
              'Submission changed while opening correction draft',
            )

          const auditPayload = {
            source_submission_id: submission.id,
            restored_boundary_count: restoredBoundaries.length,
            restored_key_point_count:
              preservedContacts?.length ??
              (options.regenerateAnalysisContacts ? 0 : submission.keyPoints.length),
            preserved_reviewed_contacts: Boolean(preservedContacts),
            regenerated_analysis_contacts: Boolean(options.regenerateAnalysisContacts),
            reverse_court_sides: Boolean(options.reverseCourtSides),
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
            annotation_status: 'open',
            rally_id: rally.id,
            revision: revision.toString(),
            score_resolution: submission.scoreResolutionState.toLowerCase() as
              | 'resolved'
              | 'unknown',
            scoring_court_side:
              (submission.scoringCourtSide?.toLowerCase() as 'left' | 'right' | undefined) ?? null,
            supersedes_submission_id: submission.id,
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
    } catch (error) {
      failure = error
      if (!isRetryable(error)) throw error
    }
  }
  throw failure
}

export async function cancelCorrectionDraft(
  database: PrismaClient,
  rallyId: string,
  identity: CorrectionDraftIdentity,
): Promise<CancelCorrectionDraftResult> {
  if (!CORRECTION_ROLES.has(identity.role)) {
    throw new CorrectionDraftError('FORBIDDEN', 'Correction drafts require annotation access')
  }
  let failure: unknown
  for (let attempt = 0; attempt < SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await database.$transaction(
        async tx => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`annotation-rally:${rallyId}`}, 0))::text AS lock`
          const device = await tx.deviceSession.findFirst({
            where: { id: identity.deviceSessionId, revokedAt: null, userId: identity.userId },
            select: { id: true },
          })
          if (!device)
            throw new CorrectionDraftError(
              'UNAUTHENTICATED',
              'Authenticated device session is not active',
            )
          const rally = await tx.rally.findUnique({
            where: { id: rallyId },
            include: {
              activeSubmission: {
                include: {
                  keyPoints: { orderBy: [{ sequenceIndex: 'asc' }, { id: 'asc' }] },
                  supersedes: {
                    include: {
                      analysisRuns: { where: { status: 'COMPLETED' }, take: 1 },
                      keyPoints: { orderBy: [{ sequenceIndex: 'asc' }, { id: 'asc' }] },
                    },
                  },
                },
              },
              keyPoints: true,
            },
          })
          if (!rally) throw new CorrectionDraftError('NOT_FOUND', 'Rally was not found')
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`annotation-set:${rally.setId}`}, 0))::text AS lock`
          const authorized =
            identity.role === UserRole.ADMIN ||
            (await tx.matchMember.findFirst({
              where: {
                matchId: rally.matchId,
                userId: identity.userId,
                role: { in: [UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR] },
              },
              select: { userId: true },
            }))
          if (!authorized)
            throw new CorrectionDraftError(
              'FORBIDDEN',
              'Rally is outside the current annotation scope',
            )
          const submission = rally.activeSubmission
          const failedSubmittedCorrection = Boolean(
            submission?.supersedes &&
            rally.annotationStatus === 'SUBMITTED' &&
            rally.processingStatus === 'FAILED',
          )
          if (
            !submission ||
            submission.status !== 'ACTIVE' ||
            (!['OPEN', 'READY'].includes(rally.annotationStatus) && !failedSubmittedCorrection) ||
            rally.voidedAt !== null
          ) {
            throw new CorrectionDraftError(
              'INVALID_SUBMISSION_STATE',
              'Only an active or failed submitted correction can be cancelled',
            )
          }
          const restoredSubmission = failedSubmittedCorrection ? submission.supersedes! : submission
          const revision = rally.annotationRevision + 1n
          const now = new Date()
          const snapshotIds = new Set(
            restoredSubmission.keyPoints.map(point => point.sourceDraftKeyPointId),
          )
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
          for (const point of restoredSubmission.keyPoints) {
            const data = {
              captureEpochId: point.captureEpochId,
              captureFrameIndex: point.captureFrameIndex,
              captureTimeUs: point.captureTimeUs,
              deletedAt: null,
              deviceSessionId: identity.deviceSessionId,
              isTerminal: point.isTerminal,
              markerKind: point.markerKind,
              originalPlaybackCursor: json({
                source: 'immutable_submission_correction_cancelled',
                submission_id: restoredSubmission.id,
              }),
              possibleDuplicate: false,
              sequenceIndex: point.sequenceIndex,
              snapDistanceUs: null,
              sourcePts: point.sourcePts,
              timingPrecision: point.timingPrecision,
              updatedByUserId: identity.userId,
            } as const
            const existing = rally.keyPoints.find(
              candidate => candidate.id === point.sourceDraftKeyPointId,
            )
            if (existing) await tx.keyPoint.update({ where: { id: existing.id }, data })
            else
              await tx.keyPoint.create({
                data: {
                  ...data,
                  createdByUserId: identity.userId,
                  id: point.sourceDraftKeyPointId,
                  rallyId: rally.id,
                },
              })
          }
          for (const point of rally.keyPoints) {
            if (!snapshotIds.has(point.id))
              await tx.keyPoint.update({
                where: { id: point.id },
                data: { deletedAt: now, updatedByUserId: identity.userId },
              })
          }
          if (failedSubmittedCorrection) {
            const correctionLedger = await tx.scoreLedgerEntry.findFirst({
              where: { kind: 'CORRECTION', submissionId: submission.id },
              orderBy: { scoreRevisionAfter: 'desc' },
            })
            if (correctionLedger) {
              const set = await tx.matchSet.findUniqueOrThrow({ where: { id: rally.setId } })
              const leftAfter = set.leftScore - correctionLedger.leftDelta
              const rightAfter = set.rightScore - correctionLedger.rightDelta
              const scoreRevisionAfter = set.scoreRevision + 1
              const scoreChanged = await tx.matchSet.updateMany({
                where: { id: set.id, scoreRevision: set.scoreRevision },
                data: {
                  leftScore: leftAfter,
                  rightScore: rightAfter,
                  scoreRevision: scoreRevisionAfter,
                },
              })
              if (scoreChanged.count !== 1)
                throw new CorrectionDraftError(
                  'INVALID_SUBMISSION_STATE',
                  'Set score changed while rolling back the correction',
                )
              await tx.scoreLedgerEntry.create({
                data: {
                  kind: 'CORRECTION_ROLLBACK',
                  setId: set.id,
                  submissionId: submission.id,
                  supersededSubmissionId: restoredSubmission.id,
                  reversalOfEntryId: correctionLedger.id,
                  leftDelta: -correctionLedger.leftDelta,
                  rightDelta: -correctionLedger.rightDelta,
                  leftScoreBefore: set.leftScore,
                  rightScoreBefore: set.rightScore,
                  leftScoreAfter: leftAfter,
                  rightScoreAfter: rightAfter,
                  scoreRevisionBefore: set.scoreRevision,
                  scoreRevisionAfter,
                },
              })
            }
            await Promise.all([
              tx.rallySubmission.update({
                where: { id: submission.id },
                data: { status: 'SUPERSEDED' },
              }),
              tx.rallySubmission.update({
                where: { id: restoredSubmission.id },
                data: { status: 'ACTIVE' },
              }),
              tx.clipJob.updateMany({
                where: { submissionId: submission.id, status: { not: 'COMPLETED' } },
                data: { status: 'CANCELLED', leasedUntil: null },
              }),
              tx.aiJob.updateMany({
                where: { submissionId: submission.id, status: { not: 'COMPLETED' } },
                data: { status: 'CANCELLED', leasedUntil: null },
              }),
              tx.analysisRun.updateMany({
                where: { submissionId: submission.id },
                data: { status: 'SUPERSEDED' },
              }),
            ])
          }
          const changed = await tx.rally.updateMany({
            where: {
              id: rally.id,
              activeSubmissionId: submission.id,
              annotationRevision: rally.annotationRevision,
              annotationStatus: failedSubmittedCorrection ? 'SUBMITTED' : { in: ['OPEN', 'READY'] },
            },
            data: {
              annotationRevision: revision,
              annotationStatus: 'SUBMITTED',
              activeSubmissionId: restoredSubmission.id,
              processingStatus:
                failedSubmittedCorrection && submission.supersedes!.analysisRuns.length > 0
                  ? 'COMPLETED'
                  : rally.processingStatus,
              scoreResolutionState: restoredSubmission.scoreResolutionState,
              scoringCourtSide: restoredSubmission.scoringCourtSide,
              scoringTeamId: restoredSubmission.scoringTeamId,
              sideAssignmentReversed: restoredSubmission.sideAssignmentReversed,
              leftScoreBefore: restoredSubmission.leftScoreBefore,
              rightScoreBefore: restoredSubmission.rightScoreBefore,
              leftScoreAfter: restoredSubmission.leftScoreAfter,
              rightScoreAfter: restoredSubmission.rightScoreAfter,
            },
          })
          if (changed.count !== 1)
            throw new CorrectionDraftError(
              'INVALID_SUBMISSION_STATE',
              'Correction draft changed while cancelling',
            )
          const auditPayload = {
            active_submission_id: restoredSubmission.id,
            failed_submission_id: failedSubmittedCorrection ? submission.id : null,
          }
          await tx.annotationOperation.create({
            data: {
              baseRevision: rally.annotationRevision,
              clientMutationId: `correction-cancel:${rally.id}:${revision}`,
              deviceSessionId: identity.deviceSessionId,
              operationKind: 'CANCEL_CORRECTION_DRAFT',
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
              dedupeKey: `correction-cancelled:${rally.id}:${revision}`,
              eventType: 'annotation.correction_draft_cancelled.v1',
              payload: json({
                rally_id: rally.id,
                revision: revision.toString(),
                active_submission_id: restoredSubmission.id,
                failed_submission_id: failedSubmittedCorrection ? submission.id : null,
              }),
            },
          })
          return {
            active_submission_id: restoredSubmission.id,
            annotation_status: 'submitted',
            rally_id: rally.id,
            revision: revision.toString(),
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
    } catch (error) {
      failure = error
      if (!isRetryable(error)) throw error
    }
  }
  throw failure
}
