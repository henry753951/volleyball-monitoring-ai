import { randomUUID } from 'node:crypto'
import type { Prisma } from '@volleyball-monitoring/db/client'
import { CONTACT_ASSOCIATION_ALGORITHM } from '../analysis/contact-association.js'
import { readClipFrameTimeline, timingManifestIdentity } from '../../media/clip-timing-coverage.js'
import type { MediaObjectReader } from '../../media/playback-domain.js'

type Tx = Prisma.TransactionClient

interface SubmissionKeyPointIdentity {
  id: string
  sequenceIndex: number
}

interface SubmissionKeyPointAnchor extends SubmissionKeyPointIdentity {
  actorRosterEntryId: string | null
  captureEpochId: string
  captureFrameIndex: bigint
  captureTimeUs: bigint
  sourcePts: bigint
}

interface SubmissionBoundaryIdentity {
  id: string
  kind: 'START' | 'END'
}

interface GeometryReuseInput {
  allowLegacyMappingCopy: boolean
  newBoundaries: SubmissionBoundaryIdentity[]
  newKeyPoints: SubmissionKeyPointAnchor[]
  newSubmissionId: string
  sourceBoundaries: SubmissionBoundaryIdentity[]
  sourceKeyPoints: SubmissionKeyPointIdentity[]
  sourceSubmissionId: string
  timingManifestReader?: MediaObjectReader
}

interface ReusedKeyPointMapping {
  submissionKeyPointId: string
  clipPts: bigint
  clipTimeUs: bigint
  clipFrameIndex: bigint
}

function sourceFrameKey(point: {
  captureEpochId: string
  captureFrameIndex: bigint
  captureTimeUs: bigint
  sourcePts: bigint
}) {
  return `${point.captureEpochId}:${point.captureFrameIndex}:${point.captureTimeUs}:${point.sourcePts}`
}

/**
 * Reuse immutable clip bytes plus the completed analysis evidence lineage.
 * Human event semantics are projected over that evidence by the read model;
 * no heavy AI job is created for an identical geometry correction.
 */
export async function reuseCompletedSubmissionGeometry(
  tx: Tx,
  input: GeometryReuseInput,
): Promise<boolean> {
  const sourceClip = await tx.clipJob.findFirst({
    where: {
      submissionId: input.sourceSubmissionId,
      status: 'COMPLETED',
      clipAssetId: { not: null },
      timingManifestAssetId: { not: null },
      actualStartCaptureUs: { not: null },
      actualEndCaptureUs: { not: null },
    },
    include: {
      keyPointMappings: true,
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
    orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
  })
  if (!sourceClip) return false

  const sourceSubmission = await tx.rallySubmission.findUnique({
    where: { id: input.sourceSubmissionId },
    select: {
      analysisSourceRunId: true,
      analysisSourceRun: { select: { id: true, reviewRevision: true } },
      analysisRuns: {
        where: { status: 'COMPLETED' },
        orderBy: [{ activatedAt: 'desc' }, { id: 'desc' }],
        take: 1,
        select: { id: true, reviewRevision: true },
      },
    },
  })
  const analysisSourceRunId =
    sourceSubmission?.analysisRuns[0]?.id ?? sourceSubmission?.analysisSourceRunId ?? null
  if (!analysisSourceRunId) return false
  const sourceAnalysis = sourceSubmission?.analysisRuns[0] ?? sourceSubmission?.analysisSourceRun

  const newBySequence = new Map(input.newKeyPoints.map(point => [point.sequenceIndex, point]))
  const newIdByOldId = new Map<string, string>()
  for (const oldPoint of input.sourceKeyPoints) {
    const replacement = newBySequence.get(oldPoint.sequenceIndex)
    if (!replacement) return false
    newIdByOldId.set(oldPoint.id, replacement.id)
  }
  const newBoundaryByKind = new Map(input.newBoundaries.map(boundary => [boundary.kind, boundary]))
  for (const sourceBoundary of input.sourceBoundaries) {
    const replacement = newBoundaryByKind.get(sourceBoundary.kind)
    if (!replacement) return false
    newIdByOldId.set(sourceBoundary.id, replacement.id)
  }

  let reusedMappings: ReusedKeyPointMapping[]
  if (input.allowLegacyMappingCopy) {
    if (
      sourceClip.keyPointMappings.some(mapping => !newIdByOldId.has(mapping.submissionKeyPointId))
    )
      return false
    reusedMappings = sourceClip.keyPointMappings.map(mapping => ({
      submissionKeyPointId: newIdByOldId.get(mapping.submissionKeyPointId)!,
      clipPts: mapping.clipPts,
      clipTimeUs: mapping.clipTimeUs,
      clipFrameIndex: mapping.clipFrameIndex,
    }))
  } else {
    if (!input.timingManifestReader || !sourceClip.timingManifest) return false
    const timeline = await readClipFrameTimeline(
      input.timingManifestReader,
      sourceClip.timingManifest,
      timingManifestIdentity(
        sourceClip.id,
        sourceClip.idempotencyKey,
        sourceClip.timingManifest.objectKey,
      ),
    ).catch(() => null)
    if (!timeline) return false
    const frameBySource = new Map<string, number>()
    for (let index = 0; index < timeline.captureTimeUs.length; index += 1) {
      const key = sourceFrameKey({
        captureEpochId: timeline.captureEpochId[index]!,
        captureFrameIndex: timeline.captureFrameIndex[index]!,
        captureTimeUs: timeline.captureTimeUs[index]!,
        sourcePts: timeline.sourcePts[index]!,
      })
      if (frameBySource.has(key)) return false
      frameBySource.set(key, index)
    }
    reusedMappings = input.newKeyPoints.flatMap(point => {
      const index = frameBySource.get(sourceFrameKey(point))
      return index === undefined
        ? []
        : [
            {
              submissionKeyPointId: point.id,
              clipPts: timeline.clipPts[index]!,
              clipTimeUs: timeline.clipTimeUs[index]!,
              clipFrameIndex: BigInt(index),
            },
          ]
    })
    if (reusedMappings.length !== input.newKeyPoints.length) return false
    if (
      new Set(reusedMappings.map(mapping => mapping.clipFrameIndex.toString())).size !==
      reusedMappings.length
    )
      return false
  }

  const now = new Date()
  const clipJobId = randomUUID()

  await tx.clipJob.create({
    data: {
      id: clipJobId,
      submissionId: input.newSubmissionId,
      status: 'COMPLETED',
      idempotencyKey: `rally-submission:${input.newSubmissionId}:reuse:${sourceClip.id}`,
      clipSchemaVersion: sourceClip.clipSchemaVersion,
      canonicalizationProfileVersion: sourceClip.canonicalizationProfileVersion,
      requestedStartCaptureUs: sourceClip.requestedStartCaptureUs,
      requestedEndCaptureUs: sourceClip.requestedEndCaptureUs,
      actualStartCaptureUs: sourceClip.actualStartCaptureUs,
      actualEndCaptureUs: sourceClip.actualEndCaptureUs,
      clipAssetId: sourceClip.clipAssetId,
      timingManifestAssetId: sourceClip.timingManifestAssetId,
      attemptCount: 0,
      maxAttempts: sourceClip.maxAttempts,
      availableAt: now,
      startedAt: now,
      completedAt: now,
      errorCode: null,
      errorMessage: null,
    },
  })
  if (reusedMappings.length) {
    await tx.clipKeyPointMapping.createMany({
      data: reusedMappings.map(mapping => ({
        clipJobId,
        submissionKeyPointId: mapping.submissionKeyPointId,
        clipPts: mapping.clipPts,
        clipTimeUs: mapping.clipTimeUs,
        clipFrameIndex: mapping.clipFrameIndex,
      })),
    })
  }

  await tx.rallySubmission.update({
    where: { id: input.newSubmissionId },
    data: { analysisSourceRunId },
  })

  if (!input.allowLegacyMappingCopy && sourceAnalysis) {
    const pointById = new Map(input.newKeyPoints.map(point => [point.id, point]))
    const associationRows = reusedMappings.flatMap(mapping =>
      pointById.get(mapping.submissionKeyPointId)?.actorRosterEntryId
        ? []
        : [
            {
              analysisRunId: sourceAnalysis.id,
              keyPointId: mapping.submissionKeyPointId,
              reviewRevision: sourceAnalysis.reviewRevision,
              frameIndex: mapping.clipFrameIndex,
              algorithmNamespace: CONTACT_ASSOCIATION_ALGORITHM,
            },
          ],
    )
    if (associationRows.length) {
      await tx.analysisContactAssociationJob.createMany({
        data: associationRows,
        skipDuplicates: true,
      })
    }
  }

  return true
}
