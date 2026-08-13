import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@volleyball-monitoring/db/client'

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

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
    : JSON.stringify(value)

function rewritePayload(
  value: unknown,
  replacements: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === 'string') return replacements.get(value) ?? value
  if (Array.isArray(value)) return value.map(entry => rewritePayload(entry, replacements))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewritePayload(entry, replacements)]))
  }
  return value
}

function reusableRequestPayload(
  value: Prisma.JsonValue,
  replacements: ReadonlyMap<string, string>,
): Record<string, unknown> | null {
  const rewritten = rewritePayload(value, replacements)
  if (!rewritten || Array.isArray(rewritten) || typeof rewritten !== 'object') return null
  const payload = { ...(rewritten as Record<string, unknown>) }
  const clipValue = payload.clip
  if (!clipValue || Array.isArray(clipValue) || typeof clipValue !== 'object') return null
  const clip = { ...(clipValue as Record<string, unknown>) }
  delete clip.download_url
  delete clip.download_url_expires_at
  delete payload.callback
  delete payload.reuse
  payload.clip = clip
  return payload
}

/**
 * Reuse only immutable clip bytes and their exact key-point mappings.
 * Analysis is intentionally never cloned: every correction must be offered to
 * a real AI Worker so ReID, physics contacts, model versions and artifacts are
 * produced for the new immutable submission.
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

  const sourceAi = await tx.aiJob.findFirst({
    where: { submissionId: input.sourceSubmissionId, status: 'COMPLETED' },
    orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
  })
  if (!sourceAi) return false

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
  if (sourceClip.keyPointMappings.some(mapping => !newIdByOldId.has(mapping.submissionKeyPointId))) return false

  const now = new Date()
  const clipJobId = randomUUID()
  const aiJobId = randomUUID()
  const replacements = new Map<string, string>([
    [input.sourceSubmissionId, input.newSubmissionId],
    [sourceClip.id, clipJobId],
    [sourceAi.id, aiJobId],
    ...newIdByOldId.entries(),
  ])
  const reusable = reusableRequestPayload(sourceAi.requestPayload, replacements)
  if (!reusable) return false
  const requestPayload = {
    ...reusable,
    schema_version: '3.0.0',
    ai_job_id: aiJobId,
    rally_submission_id: input.newSubmissionId,
    annotation_revision: input.annotationRevision.toString(),
    outcome: {
      score_resolution: input.outcome.resolution.toLowerCase(),
      scoring_court_side: input.outcome.side?.toLowerCase() ?? null,
    },
    analysis_plan: {
      mode: 'full',
      modules: { court: 'run', tracking: 'run', reid: 'run', contacts: 'run' },
      source_analysis_data: null,
      preserve_manual_corrections: true,
    },
  }

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

  await tx.aiJob.create({
    data: {
      id: aiJobId,
      submissionId: input.newSubmissionId,
      clipJobId,
      status: 'QUEUED',
      idempotencyKey: `volleyball-analysis-engine:${input.newSubmissionId}:${clipJobId}:rerun`,
      requestPayload: json(requestPayload),
      requestPayloadHash: createHash('sha256').update(canonical(requestPayload)).digest('hex'),
      jobSchemaVersion: '3.0.0',
      callbackTokenHash: createHash('sha256').update(`queued:${aiJobId}`).digest('hex'),
      callbackTokenExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
      attemptCount: 0,
      maxAttempts: sourceAi.maxAttempts,
      availableAt: now,
      progress: null,
      stage: 'waiting_worker',
    },
  })

  return true
}
