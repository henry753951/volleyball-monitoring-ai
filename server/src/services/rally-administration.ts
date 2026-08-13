import type { PrismaClient } from '@volleyball-monitoring/db'
import { Prisma, UserRole } from '@volleyball-monitoring/db/client'
import { deriveRallyDisplayOrdinals, segmentStartCaptureTimeUs } from '../domain/rally-display-order.js'
import type { AuthenticatedUser } from '../graphql/context.js'
import { domainError } from '../graphql/errors.js'
import type { MediaObjectLocation, MediaObjectRemover } from '../media/media-object-remover.js'

const EDIT_ROLES = new Set<UserRole>([UserRole.ADMIN, UserRole.OPERATOR, UserRole.ANNOTATOR])
const ACTIVE_JOB_STATUSES = ['QUEUED', 'RUNNING'] as const
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

interface CleanupAsset extends MediaObjectLocation { byteLength: bigint | null; id: string }

export interface RallyDeleteReceipt {
  rallyId: string
  matchId: string
  abortedJobCount: number
  removedAssetCount: number
  removedBytes: string
  cleanupWarnings: string[]
}

export interface RallyPlacementResult {
  rallyId: string
  matchId: string
  displaySetNumber: number
  displayOrdinal: number
}

export interface RallyAdministrationDependencies {
  database: PrismaClient
  objectRemover?: MediaObjectRemover
  notifyMatchChanged?: (matchId: string, reason: 'rally_deleted' | 'rally_placement_updated') => void
}

type RallyPlacementTransaction = Prisma.TransactionClient
type RallyPlacementReader = Pick<PrismaClient, 'rally'>

type RallyPlacementRow = {
  id: string
  displaySetNumber: number
  boundaries: Array<{ captureTimeUs: bigint; kind: string }>
  keyPoints: Array<{ captureTimeUs: bigint; markerKind: string }>
  activeSubmission: null | {
    boundaries: Array<{ captureTimeUs: bigint; kind: string }>
    keyPoints: Array<{ captureTimeUs: bigint; markerKind: string }>
  }
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}

function requireUuid(value: string, name: string): string {
  if (!UUID.test(value)) domainError(`${name} must be a UUID`, 'BAD_USER_INPUT')
  return value.toLowerCase()
}

async function authorizeRally(database: PrismaClient, actor: AuthenticatedUser, rallyId: string) {
  if (!EDIT_ROLES.has(actor.role)) domainError('Insufficient role', 'FORBIDDEN')
  const rally = await database.rally.findFirst({
    select: { id: true, matchId: true },
    where: {
      id: rallyId,
      ...(actor.role === UserRole.ADMIN ? {} : {
        match: { members: { some: { userId: actor.id, role: { in: [...EDIT_ROLES] } } } },
      }),
    },
  })
  if (!rally) domainError('Rally was not found', 'NOT_FOUND')
  return rally
}

export async function getDerivedRallyDisplayOrdinal(
  database: RallyPlacementReader,
  matchId: string,
  rallyId: string,
): Promise<number> {
  const rallies = await database.rally.findMany({
    where: { matchId, voidedAt: null },
    select: {
      id: true,
      displaySetNumber: true,
      boundaries: {
        where: { kind: 'START' },
        orderBy: [{ captureTimeUs: 'asc' }, { id: 'asc' }],
        take: 1,
        select: { captureTimeUs: true, kind: true },
      },
      keyPoints: {
        where: { deletedAt: null },
        orderBy: [{ captureTimeUs: 'asc' }, { captureFrameIndex: 'asc' }, { id: 'asc' }],
        select: { captureTimeUs: true, markerKind: true },
      },
      activeSubmission: {
        select: {
          boundaries: {
            where: { kind: 'START' },
            orderBy: [{ captureTimeUs: 'asc' }, { id: 'asc' }],
            take: 1,
            select: { captureTimeUs: true, kind: true },
          },
          keyPoints: {
            orderBy: [{ captureTimeUs: 'asc' }, { captureFrameIndex: 'asc' }, { id: 'asc' }],
            select: { captureTimeUs: true, markerKind: true },
          },
        },
      },
    },
  }) as RallyPlacementRow[]
  const candidates = rallies.map(rally => ({
    displaySetNumber: rally.displaySetNumber,
    id: rally.id,
    startCaptureTimeUs: segmentStartCaptureTimeUs(rally)
      ?? segmentStartCaptureTimeUs(rally.activeSubmission ?? {}),
  }))
  return deriveRallyDisplayOrdinals(candidates).get(rallyId) ?? 1
}

export async function updateRallyDisplayPlacement(
  actor: AuthenticatedUser,
  input: { rallyId: string; setNumber: number; ordinal: number },
  dependencies: RallyAdministrationDependencies,
): Promise<RallyPlacementResult> {
  const rallyId = requireUuid(input.rallyId, 'rallyId')
  if (!Number.isInteger(input.setNumber) || input.setNumber < 1 || input.setNumber > 99) {
    domainError('Set number must be between 1 and 99', 'BAD_USER_INPUT')
  }
  // Keep ordinal in the existing GraphQL input for backward compatibility,
  // but never trust it as placement authority. Capture order decides the value.
  if (!Number.isInteger(input.ordinal) || input.ordinal < 1 || input.ordinal > 999) {
    domainError('Rally ordinal must be between 1 and 999', 'BAD_USER_INPUT')
  }
  const authorized = await authorizeRally(dependencies.database, actor, rallyId)
  const result = await dependencies.database.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${authorized.matchId}))`
    const setExists = await tx.matchSet.count({ where: { matchId: authorized.matchId, setNumber: input.setNumber } })
    if (!setExists) domainError('The selected set does not exist', 'BAD_USER_INPUT')
    const updated = await tx.rally.update({
      data: { displaySetNumber: input.setNumber },
      select: { displaySetNumber: true, id: true, matchId: true },
      where: { id: rallyId },
    })
    return {
      displayOrdinal: await getDerivedRallyDisplayOrdinal(tx, authorized.matchId, rallyId),
      displaySetNumber: updated.displaySetNumber,
      matchId: updated.matchId,
      rallyId: updated.id,
    }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  dependencies.notifyMatchChanged?.(result.matchId, 'rally_placement_updated')
  return result
}

export async function deleteRallyWithMedia(
  actor: AuthenticatedUser,
  rawRallyId: string,
  dependencies: RallyAdministrationDependencies,
): Promise<RallyDeleteReceipt> {
  const rallyId = requireUuid(rawRallyId, 'rallyId')
  const authorized = await authorizeRally(dependencies.database, actor, rallyId)
  const transactionResult = await dependencies.database.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${authorized.matchId}))`
    await tx.$queryRaw`SELECT id FROM "Rally" WHERE id = ${rallyId}::uuid FOR UPDATE`
    const rally = await tx.rally.findUnique({
      select: {
        id: true,
        matchId: true,
        setId: true,
        displaySetNumber: true,
        submissions: { select: { id: true } },
      },
      where: { id: rallyId },
    })
    if (!rally) domainError('Rally was not found', 'NOT_FOUND')
    // Resolve the media set only after locking the Rally. Querying it before the
    // transaction allowed a just-finished worker callback to attach an artifact
    // between discovery and deletion, leaving an orphaned object behind.
    const assets = await tx.mediaAsset.findMany({
      select: { bucket: true, byteLength: true, id: true, objectKey: true },
      where: { OR: [
        { clipOutputs: { some: { submission: { rallyId } } } },
        { clipTimingManifests: { some: { submission: { rallyId } } } },
        { analysisDataRaw: { some: { submission: { rallyId } } } },
        { analysisArtifacts: { some: { analysisRun: { submission: { rallyId } } } } },
        { analysisFrameChunks: { some: { manifest: { analysisRun: { submission: { rallyId } } } } } },
      ] },
    }) as CleanupAsset[]
    const submissionIds = rally.submissions.map(submission => submission.id)
    const clipJobIds = submissionIds.length
      ? (await tx.clipJob.findMany({ select: { id: true }, where: { submissionId: { in: submissionIds } } })).map(job => job.id)
      : []
    const aiJobs = submissionIds.length
      ? await tx.aiJob.findMany({
          select: { deliveryId: true, id: true, providerInstanceId: true, status: true },
          where: { submissionId: { in: submissionIds } },
        })
      : []
    const analysisRunIds = submissionIds.length
      ? (await tx.analysisRun.findMany({ select: { id: true }, where: { submissionId: { in: submissionIds } } })).map(run => run.id)
      : []
    const ledgerEntries = submissionIds.length
      ? await tx.scoreLedgerEntry.findMany({
          select: { id: true, leftDelta: true, rightDelta: true },
          where: { OR: [
            { submissionId: { in: submissionIds } },
            { supersededSubmissionId: { in: submissionIds } },
          ] },
        })
      : []

    const activeAiJobs = aiJobs.filter(job => ACTIVE_JOB_STATUSES.includes(job.status as typeof ACTIVE_JOB_STATUSES[number]))
    const obsoleteAggregateIds = [rally.id, ...submissionIds, ...clipJobIds, ...aiJobs.map(job => job.id), ...analysisRunIds]
    if (obsoleteAggregateIds.length) await tx.outboxEvent.deleteMany({ where: { aggregateId: { in: obsoleteAggregateIds } } })
    for (const job of activeAiJobs.filter(job => job.deliveryId && job.providerInstanceId)) {
      await tx.outboxEvent.create({
        data: {
          aggregateId: job.id,
          aggregateType: 'AiJob',
          dedupeKey: `ai-abort:purge:${job.id}`,
          eventType: 'ai.job_abort_requested.v1',
          payload: json({
            ai_job_id: job.id,
            delivery_id: job.deliveryId,
            provider_instance_id: job.providerInstanceId,
            rally_id: rally.id,
            reason: 'rally_deleted',
          }),
        },
      })
    }

    await tx.rally.update({ data: { activeSubmissionId: null }, where: { id: rally.id } })
    if (analysisRunIds.length) await tx.analysisRun.deleteMany({ where: { id: { in: analysisRunIds } } })
    if (aiJobs.length) await tx.aiJob.deleteMany({ where: { id: { in: aiJobs.map(job => job.id) } } })
    if (clipJobIds.length) await tx.clipJob.deleteMany({ where: { id: { in: clipJobIds } } })
    if (submissionIds.length) {
      await tx.pointAward.deleteMany({ where: { submissionId: { in: submissionIds } } })
      if (ledgerEntries.length) await tx.scoreLedgerEntry.deleteMany({ where: { id: { in: ledgerEntries.map(entry => entry.id) } } })
      await tx.rallySubmission.updateMany({
        data: { serviceKeyPointId: null, supersedesSubmissionId: null, terminalKeyPointId: null },
        where: { id: { in: submissionIds } },
      })
      await tx.rallySubmissionBoundary.deleteMany({ where: { submissionId: { in: submissionIds } } })
      await tx.rallySubmissionKeyPoint.deleteMany({ where: { submissionId: { in: submissionIds } } })
      await tx.rallySubmission.deleteMany({ where: { id: { in: submissionIds } } })
    }
    await tx.annotationOperation.deleteMany({ where: { rallyId: rally.id } })
    await tx.annotationCommandReceipt.deleteMany({ where: { rallyId: rally.id } })
    await tx.rally.delete({ where: { id: rally.id } })

    const leftDelta = ledgerEntries.reduce((sum, entry) => sum + entry.leftDelta, 0)
    const rightDelta = ledgerEntries.reduce((sum, entry) => sum + entry.rightDelta, 0)
    if (leftDelta !== 0 || rightDelta !== 0) {
      const set = await tx.matchSet.findUniqueOrThrow({ where: { id: rally.setId } })
      await tx.matchSet.update({
        data: {
          leftScore: Math.max(0, set.leftScore - leftDelta),
          rightScore: Math.max(0, set.rightScore - rightDelta),
          scoreRevision: { increment: 1 },
        },
        where: { id: set.id },
      })
    }
    if (assets.length) await tx.mediaAsset.deleteMany({
      where: {
        id: { in: assets.map(asset => asset.id) },
        analysisArtifacts: { none: {} }, analysisDataRaw: { none: {} },
        clipOutputs: { none: {} }, clipTimingManifests: { none: {} }, dvrInitSegments: { none: {} },
        dvrMediaSegments: { none: {} }, dvrSampleIndexSegments: { none: {} }, analysisFrameChunks: { none: {} },
      },
    })
    return { abortedJobCount: activeAiJobs.length, assets, matchId: rally.matchId }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })

  const { assets } = transactionResult
  const retained = assets.length
    ? new Set((await dependencies.database.mediaAsset.findMany({
        select: { id: true }, where: { id: { in: assets.map(asset => asset.id) } },
      })).map(asset => asset.id))
    : new Set<string>()
  const removedAssets = assets.filter(asset => !retained.has(asset.id))
  const cleanupWarnings: string[] = []
  if (dependencies.objectRemover) {
    for (const asset of removedAssets) {
      try { await dependencies.objectRemover(asset) }
      catch { cleanupWarnings.push(`物件儲存清理失敗：${asset.bucket}/${asset.objectKey}`) }
    }
  }
  else if (removedAssets.length) cleanupWarnings.push('物件儲存清理未設定')

  dependencies.notifyMatchChanged?.(transactionResult.matchId, 'rally_deleted')
  return {
    abortedJobCount: transactionResult.abortedJobCount,
    cleanupWarnings,
    matchId: transactionResult.matchId,
    rallyId,
    removedAssetCount: removedAssets.length,
    removedBytes: removedAssets.reduce((sum, asset) => sum + (asset.byteLength ?? 0n), 0n).toString(),
  }
}
