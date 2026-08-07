import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@volleyball-monitoring/db/client'

type Tx = Prisma.TransactionClient

interface SubmissionKeyPointIdentity {
  id: string
  sequenceIndex: number
}

interface GeometryReuseInput {
  annotationRevision: bigint
  newKeyPoints: SubmissionKeyPointIdentity[]
  newSubmissionId: string
  outcome: {
    resolution: 'RESOLVED' | 'UNKNOWN'
    side: 'LEFT' | 'RIGHT' | null
  }
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
    include: {
      analysisRun: {
        include: {
          artifacts: true,
          contactEvents: {
            include: { actors: true, candidates: true, representativePositions: true },
            orderBy: { sequenceIndex: 'asc' },
          },
          overlayManifest: { include: { chunks: { orderBy: { chunkIndex: 'asc' } } } },
          segments: { include: { positions: true }, orderBy: { sequenceIndex: 'asc' } },
          tracks: { include: { identityAssignments: true }, orderBy: { trackId: 'asc' } },
        },
      },
    },
    orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
  })
  const sourceAnalysis = sourceAi?.analysisRun
  if (!sourceAi || !sourceAnalysis || sourceAnalysis.status !== 'COMPLETED') return false

  const sourceById = new Map(input.sourceKeyPoints.map(point => [point.id, point]))
  const newBySequence = new Map(input.newKeyPoints.map(point => [point.sequenceIndex, point]))
  const newIdByOldId = new Map<string, string>()
  for (const oldPoint of input.sourceKeyPoints) {
    const replacement = newBySequence.get(oldPoint.sequenceIndex)
    if (!replacement) return false
    newIdByOldId.set(oldPoint.id, replacement.id)
  }
  if (
    sourceClip.keyPointMappings.some(mapping => !newIdByOldId.has(mapping.submissionKeyPointId))
    || sourceAnalysis.contactEvents.some(event => !newIdByOldId.has(event.keyPointId))
    || sourceAnalysis.segments.some(segment => !newIdByOldId.has(segment.startKeyPointId) || !newIdByOldId.has(segment.endKeyPointId))
  ) return false

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
  await tx.clipKeyPointMapping.createMany({
    data: sourceClip.keyPointMappings.map(mapping => ({
      clipJobId,
      submissionKeyPointId: newIdByOldId.get(mapping.submissionKeyPointId)!,
      clipPts: mapping.clipPts,
      clipTimeUs: mapping.clipTimeUs,
      clipFrameIndex: mapping.clipFrameIndex,
    })),
  })

  const aiJobId = randomUUID()
  const replacements = new Map<string, string>([
    [input.sourceSubmissionId, input.newSubmissionId],
    [sourceClip.id, clipJobId],
    [sourceAi.id, aiJobId],
    ...newIdByOldId.entries(),
  ])
  const rewritten = rewritePayload(sourceAi.requestPayload, replacements) as Record<string, unknown>
  const requestPayload = {
    ...rewritten,
    ai_job_id: aiJobId,
    rally_submission_id: input.newSubmissionId,
    annotation_revision: input.annotationRevision.toString(),
    outcome: {
      score_resolution: input.outcome.resolution.toLowerCase(),
      scoring_court_side: input.outcome.side?.toLowerCase() ?? null,
    },
    reuse: {
      kind: 'immutable_geometry',
      source_ai_job_id: sourceAi.id,
      source_analysis_run_id: sourceAnalysis.id,
    },
  }
  await tx.aiJob.create({
    data: {
      id: aiJobId,
      integrationId: sourceAi.integrationId,
      submissionId: input.newSubmissionId,
      clipJobId,
      status: 'COMPLETED',
      idempotencyKey: `${sourceAi.integrationId}:${input.newSubmissionId}:${clipJobId}:reuse`,
      requestPayload: json(requestPayload),
      requestPayloadHash: createHash('sha256').update(canonical(requestPayload)).digest('hex'),
      jobSchemaVersion: sourceAi.jobSchemaVersion,
      callbackTokenHash: createHash('sha256').update(`geometry-reuse:${aiJobId}`).digest('hex'),
      callbackTokenExpiresAt: now,
      attemptCount: 0,
      maxAttempts: sourceAi.maxAttempts,
      availableAt: now,
      providerJobId: `reused:${sourceAi.id}`,
      progress: 1,
      stage: 'geometry_reused',
      acceptedAt: now,
      startedAt: now,
      completedAt: now,
      lastCallbackAt: now,
    },
  })

  const analysisRunId = randomUUID()
  await tx.analysisRun.create({
    data: {
      id: analysisRunId,
      aiJobId,
      submissionId: input.newSubmissionId,
      analysisId: `reuse:${sourceAnalysis.analysisId}:${input.newSubmissionId}`,
      analysisVersion: sourceAnalysis.analysisVersion,
      resultSchemaVersion: sourceAnalysis.resultSchemaVersion,
      overlaySchemaVersion: sourceAnalysis.overlaySchemaVersion,
      inputClipSha256: sourceAnalysis.inputClipSha256,
      producerName: sourceAnalysis.producerName,
      producerBuildId: sourceAnalysis.producerBuildId,
      producerSdkVersion: sourceAnalysis.producerSdkVersion,
      status: 'COMPLETED',
      rawAnalysisAssetId: sourceAnalysis.rawAnalysisAssetId,
      rawOverlayAssetId: sourceAnalysis.rawOverlayAssetId,
      ...(sourceAnalysis.summary === null ? {} : { summary: json(sourceAnalysis.summary) }),
      createdAt: now,
      activatedAt: now,
    },
  })
  await tx.analysisTrack.createMany({
    data: sourceAnalysis.tracks.map(track => ({
      analysisRunId,
      trackId: track.trackId,
      courtSide: track.courtSide,
      firstFrame: track.firstFrame,
      lastFrame: track.lastFrame,
      meanConfidence: track.meanConfidence,
      ...(track.metadata === null ? {} : { metadata: json(track.metadata) }),
    })),
  })
  await tx.trackIdentityAssignment.createMany({
    data: sourceAnalysis.tracks.flatMap(track => track.identityAssignments.map(assignment => ({
      id: randomUUID(),
      analysisRunId,
      trackId: assignment.trackId,
      rosterEntryId: assignment.rosterEntryId,
      source: assignment.source,
      assignedByUserId: assignment.assignedByUserId,
      confidence: assignment.confidence,
      createdAt: now,
    }))),
  })

  await tx.contactEvent.createMany({
    data: sourceAnalysis.contactEvents.map(event => ({
      analysisRunId,
      keyPointId: newIdByOldId.get(event.keyPointId)!,
      sequenceIndex: event.sequenceIndex,
      anchorFrameIndex: event.anchorFrameIndex,
      resolvedFrameIndex: event.resolvedFrameIndex,
      anchorTimeUs: event.anchorTimeUs,
      markerKind: event.markerKind,
      isTerminal: event.isTerminal,
      associationState: event.associationState,
      ballState: event.ballState,
      ballFrameIndex: event.ballFrameIndex,
      ballFrameX: event.ballFrameX,
      ballFrameY: event.ballFrameY,
      qualityFlags: event.qualityFlags,
    })),
  })
  for (const event of sourceAnalysis.contactEvents) {
    const keyPointId = newIdByOldId.get(event.keyPointId)!
    await tx.contactEventActor.createMany({
      data: event.actors.map(actor => ({
        analysisRunId,
        keyPointId,
        trackId: actor.trackId,
        observationFrameIndex: actor.observationFrameIndex,
        associationConfidence: actor.associationConfidence,
        frameX1: actor.frameX1,
        frameY1: actor.frameY1,
        frameX2: actor.frameX2,
        frameY2: actor.frameY2,
        frameFootX: actor.frameFootX,
        frameFootY: actor.frameFootY,
        courtX: actor.courtX,
        courtY: actor.courtY,
        ...(actor.action === null ? {} : { action: json(actor.action) }),
      })),
    })
    await tx.contactEventCandidate.createMany({
      data: event.candidates.map(candidate => ({
        analysisRunId,
        keyPointId,
        trackId: candidate.trackId,
        rank: candidate.rank,
        confidence: candidate.confidence,
      })),
    })
    await tx.contactEventPosition.createMany({
      data: event.representativePositions.map(position => ({
        id: randomUUID(),
        analysisRunId,
        keyPointId,
        positionIndex: position.positionIndex,
        trackId: position.trackId,
        basis: position.basis,
        courtX: position.courtX,
        courtY: position.courtY,
        confidence: position.confidence,
      })),
    })
  }

  for (const segment of sourceAnalysis.segments) {
    const segmentId = randomUUID()
    await tx.ballPathSegment.create({
      data: {
        id: segmentId,
        analysisRunId,
        sequenceIndex: segment.sequenceIndex,
        startKeyPointId: newIdByOldId.get(segment.startKeyPointId)!,
        endKeyPointId: newIdByOldId.get(segment.endKeyPointId)!,
        startFrameIndex: segment.startFrameIndex,
        endFrameIndex: segment.endFrameIndex,
        renderState: segment.renderState,
        isTerminalSegment: segment.isTerminalSegment,
        qualityFlags: segment.qualityFlags,
      },
    })
    await tx.ballPathSegmentPosition.createMany({
      data: segment.positions.map(position => ({
        segmentId,
        endpoint: position.endpoint,
        positionIndex: position.positionIndex,
        trackId: position.trackId,
        basis: position.basis,
        courtX: position.courtX,
        courtY: position.courtY,
        confidence: position.confidence,
      })),
    })
  }

  await tx.analysisArtifact.createMany({
    data: sourceAnalysis.artifacts.map(artifact => ({
      id: randomUUID(),
      analysisRunId,
      kind: artifact.kind,
      assetId: artifact.assetId,
      createdAt: now,
    })),
  })
  if (sourceAnalysis.overlayManifest) {
    const manifest = sourceAnalysis.overlayManifest
    await tx.overlayManifest.create({
      data: {
        analysisRunId,
        schemaVersion: manifest.schemaVersion,
        overlayVersion: manifest.overlayVersion,
        videoWidth: manifest.videoWidth,
        videoHeight: manifest.videoHeight,
        fpsNum: manifest.fpsNum,
        fpsDen: manifest.fpsDen,
        totalFrames: manifest.totalFrames,
        chunkFrameCount: manifest.chunkFrameCount,
        ...(manifest.actionTaxonomy === null ? {} : { actionTaxonomy: json(manifest.actionTaxonomy) }),
        createdAt: now,
        chunks: {
          create: manifest.chunks.map(chunk => ({
            chunkIndex: chunk.chunkIndex,
            startFrameIndex: chunk.startFrameIndex,
            frameCount: chunk.frameCount,
            assetId: chunk.assetId,
            byteLength: chunk.byteLength,
            sha256: chunk.sha256,
            createdAt: now,
          })),
        },
      },
    })
  }

  return sourceById.size === newIdByOldId.size
}
