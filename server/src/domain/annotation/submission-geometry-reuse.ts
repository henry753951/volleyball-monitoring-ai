import { randomUUID } from 'node:crypto'
import type { Prisma } from '@volleyball-monitoring/db/client'

type Tx = Prisma.TransactionClient

interface SubmissionKeyPointIdentity {
  id: string
  sequenceIndex: number
}

interface SubmissionBoundaryIdentity {
  id: string
  kind: 'START' | 'END'
}

interface GeometryReuseInput {
  annotationRevision: bigint
  newBoundaries: SubmissionBoundaryIdentity[]
  newKeyPoints: SubmissionKeyPointIdentity[]
  newSubmissionId: string
  outcome: {
    resolution: 'RESOLVED' | 'UNKNOWN'
    side: 'LEFT' | 'RIGHT' | null
  }
  sourceBoundaries: SubmissionBoundaryIdentity[]
  sourceKeyPoints: SubmissionKeyPointIdentity[]
  sourceSubmissionId: string
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
    include: { keyPointMappings: true },
    orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
  })
  if (!sourceClip) return false

  const sourceSubmission = await tx.rallySubmission.findUnique({
    where: { id: input.sourceSubmissionId },
    select: {
      analysisSourceRunId: true,
      analysisRuns: {
        where: { status: 'COMPLETED' },
        orderBy: [{ activatedAt: 'desc' }, { id: 'desc' }],
        take: 1,
        select: { id: true },
      },
    },
  })
  const analysisSourceRunId =
    sourceSubmission?.analysisRuns[0]?.id ?? sourceSubmission?.analysisSourceRunId ?? null
  if (!analysisSourceRunId) return false

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
  if (sourceClip.keyPointMappings.some(mapping => !newIdByOldId.has(mapping.submissionKeyPointId)))
    return false

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
  if (sourceClip.keyPointMappings.length) {
    await tx.clipKeyPointMapping.createMany({
      data: sourceClip.keyPointMappings.map(mapping => ({
        clipJobId,
        submissionKeyPointId: newIdByOldId.get(mapping.submissionKeyPointId)!,
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

  return true
}
