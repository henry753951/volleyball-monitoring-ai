import type { PrismaClient } from '@volleyball-monitoring/db'
import { AnnotationStatus, UserRole } from '@volleyball-monitoring/db/client'
import {
  deriveRallyDisplayOrdinals,
  segmentStartCaptureTimeUs,
} from '../domain/rally-display-order.js'
import {
  readClipFrameTimeline,
  timingManifestIdentity,
  type CaptureCoverage,
  type ClipFrameTimeline,
} from '../media/clip-timing-coverage.js'
import type { MediaObjectReader } from '../media/playback-domain.js'
import { resolveEffectiveContactFrame } from './effective-contact-frame.js'
import { deriveEffectiveSetNumberMap } from './set-display-projection.js'

export {
  deriveEffectiveSetNumberMap,
  type SetDisplayProjectionInput,
} from './set-display-projection.js'

interface CoachDashboardDependencies {
  timingManifestReader?: MediaObjectReader
}

export function selectDisplayAnalysis<T extends { status: string }>(
  current: T | null | undefined,
  previous: T | null | undefined,
  reused: T | null | undefined = null,
) {
  if (current?.status === 'COMPLETED') return { analysis: current, source: 'current' as const }
  if (reused?.status === 'COMPLETED') return { analysis: reused, source: 'reused' as const }
  if (previous?.status === 'COMPLETED') return { analysis: previous, source: 'previous' as const }
  return { analysis: null, source: null }
}

const dashboardClipSelect = {
  id: true,
  idempotencyKey: true,
  status: true,
  actualStartCaptureUs: true,
  actualEndCaptureUs: true,
  requestedStartCaptureUs: true,
  requestedEndCaptureUs: true,
  attemptCount: true,
  maxAttempts: true,
  errorCode: true,
  errorMessage: true,
  startedAt: true,
  completedAt: true,
  updatedAt: true,
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
} as const

const dashboardAnalysisSelect = {
  id: true,
  status: true,
  analysisVersion: true,
  summary: true,
  identityMappingCompletedAt: true,
  rawAnalysisDataAsset: { select: { byteLength: true } },
  artifacts: { select: { asset: { select: { byteLength: true } } } },
  analysisDataManifest: {
    select: { fpsNum: true, fpsDen: true, chunks: { select: { byteLength: true } } },
  },
  tracks: { select: { firstFrame: true, lastFrame: true } },
  contactEvents: {
    select: {
      anchorFrameIndex: true,
      resolvedFrameIndex: true,
      anchorOrigin: true,
      detectionConfidence: true,
      keyPointId: true,
    },
  },
  contactTimeCorrections: { select: { frameIndex: true, keyPointId: true } },
  contactEdits: {
    select: { baseKeyPointId: true, contactId: true, deleted: true, frameIndex: true },
  },
  _count: { select: { tracks: true, segments: true, contactEvents: true } },
} as const

function frameCoverage(
  timeline: ClipFrameTimeline,
  firstFrame: bigint | null,
  lastFrame: bigint | null,
): CaptureCoverage | null {
  if (firstFrame === null && lastFrame === null) {
    return { startUs: timeline.captureTimeUs[0]!, endUs: timeline.captureEndUs }
  }
  if (
    firstFrame === null ||
    lastFrame === null ||
    firstFrame < 0n ||
    lastFrame < firstFrame ||
    lastFrame >= BigInt(timeline.captureTimeUs.length)
  )
    return null
  const first = Number(firstFrame)
  const last = Number(lastFrame)
  return {
    startUs: timeline.captureTimeUs[first]!,
    endUs: timeline.captureTimeUs[last + 1] ?? timeline.captureEndUs,
  }
}

export async function getCoachMatchState(
  database: PrismaClient,
  input: { matchId: string; userId: string; role: UserRole },
  dependencies: CoachDashboardDependencies = {},
) {
  const match = await database.match.findFirst({
    where: {
      id: input.matchId,
      ...(input.role === UserRole.ADMIN ? {} : { members: { some: { userId: input.userId } } }),
    },
    select: {
      id: true,
      title: true,
      status: true,
      clipPreRollUs: true,
      clipPostRollUs: true,
      matchTeams: { select: { team: { select: { id: true, name: true, shortName: true } } } },
      sets: {
        orderBy: { setNumber: 'asc' },
        select: {
          id: true,
          setNumber: true,
          status: true,
          leftScore: true,
          rightScore: true,
          scoreRevision: true,
          winningTeamId: true,
          sideAssignments: {
            where: { effectiveToRallyOrdinal: null },
            orderBy: { effectiveFromRallyOrdinal: 'desc' },
            take: 1,
            select: { id: true, leftTeamId: true, rightTeamId: true },
          },
        },
      },
      captureSessions: {
        orderBy: { createdAt: 'desc' },
        select: { id: true, sourceKind: true, sourceLabel: true, status: true, health: true },
      },
      rallies: {
        where: { activeSubmissionId: { not: null }, voidedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          ordinal: true,
          displaySetNumber: true,
          annotationRevision: true,
          processingStatus: true,
          scoringCourtSide: true,
          scoringTeamId: true,
          sideAssignmentId: true,
          sideAssignmentReversed: true,
          sideAssignment: { select: { leftTeamId: true, rightTeamId: true } },
          set: { select: { id: true, setNumber: true } },
          program: { select: { captureSessionId: true } },
          activeSubmission: {
            select: {
              id: true,
              submittedAt: true,
              scoreResolutionState: true,
              scoringCourtSide: true,
              scoringTeamId: true,
              supersedesSubmissionId: true,
              leftTeamId: true,
              rightTeamId: true,
              sideAssignmentId: true,
              sideAssignmentReversed: true,
              keyPoints: {
                orderBy: { sequenceIndex: 'asc' },
                select: {
                  id: true,
                  sequenceIndex: true,
                  markerKind: true,
                  isTerminal: true,
                  captureTimeUs: true,
                  captureFrameIndex: true,
                  ballEvent: { select: { kind: true, result: true, serveStyle: true } },
                },
              },
              boundaries: {
                orderBy: { kind: 'asc' },
                select: { kind: true, captureTimeUs: true, captureFrameIndex: true },
              },
              clipJobs: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: dashboardClipSelect,
              },
              aiJobs: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: {
                  id: true,
                  status: true,
                  progress: true,
                  stage: true,
                  attemptCount: true,
                  maxAttempts: true,
                  errorCode: true,
                  errorMessage: true,
                  acceptedAt: true,
                  startedAt: true,
                  completedAt: true,
                  updatedAt: true,
                  providerJobId: true,
                  providerInstance: { select: { instanceKey: true, providerBuildId: true } },
                },
              },
              analysisRuns: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: dashboardAnalysisSelect,
              },
              analysisSourceRun: { select: dashboardAnalysisSelect },
              supersedes: {
                select: {
                  clipJobs: {
                    where: { status: 'COMPLETED' },
                    orderBy: { completedAt: 'desc' },
                    take: 1,
                    select: dashboardClipSelect,
                  },
                  analysisRuns: {
                    where: { status: 'COMPLETED' },
                    orderBy: { activatedAt: 'desc' },
                    take: 1,
                    select: dashboardAnalysisSelect,
                  },
                },
              },
            },
          },
        },
      },
    },
  })
  if (!match) return null
  const providerJobIds = match.rallies.flatMap(
    rally =>
      rally.activeSubmission?.aiJobs.flatMap(job =>
        job.providerJobId ? [job.providerJobId] : [],
      ) ?? [],
  )
  const providerJobs =
    providerJobIds.length === 0
      ? []
      : await database.providerJob.findMany({
          where: { id: { in: providerJobIds } },
          select: {
            id: true,
            status: true,
            progress: true,
            stage: true,
            attemptCount: true,
            maxAttempts: true,
            errorCode: true,
            errorMessage: true,
            updatedAt: true,
            providerInstance: { select: { instanceKey: true, providerBuildId: true } },
          },
        })
  const providerJobById = new Map(providerJobs.map(job => [job.id, job]))
  const drafts = await database.rally.findMany({
    where: {
      matchId: match.id,
      voidedAt: null,
      annotationStatus: { in: [AnnotationStatus.OPEN, AnnotationStatus.READY] },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      ordinal: true,
      displaySetNumber: true,
      annotationRevision: true,
      annotationStatus: true,
      activeSubmissionId: true,
      scoreResolutionState: true,
      scoringCourtSide: true,
      scoringTeamId: true,
      sideAssignmentId: true,
      sideAssignmentReversed: true,
      sideAssignment: { select: { leftTeamId: true, rightTeamId: true } },
      set: { select: { id: true, setNumber: true } },
      keyPoints: {
        where: { deletedAt: null },
        orderBy: { sequenceIndex: 'asc' },
        select: {
          id: true,
          sequenceIndex: true,
          markerKind: true,
          isTerminal: true,
          captureTimeUs: true,
          captureFrameIndex: true,
          ballEvent: { select: { kind: true, result: true, serveStyle: true } },
        },
      },
      boundaries: {
        orderBy: { kind: 'asc' },
        select: { kind: true, captureTimeUs: true, captureFrameIndex: true },
      },
    },
  })
  const effectiveSetNumberByRawSetNumber = deriveEffectiveSetNumberMap(match.sets)
  const effectiveSetNumberFor = (displaySetNumber: number) =>
    effectiveSetNumberByRawSetNumber.get(displaySetNumber) ?? displaySetNumber
  // The set is persisted because it is an editorial decision. The ordinal is
  // a view over capture order and must never depend on a stale database value.
  // A correction draft replaces the same rally's submitted geometry while it
  // is editable, so it intentionally wins the de-duplication below.
  const displayOrderByRallyId = new Map(
    match.rallies.flatMap(rally => {
      if (!rally.activeSubmission) return []
      return [
        [
          rally.id,
          {
            displaySetNumber: effectiveSetNumberFor(rally.displaySetNumber),
            id: rally.id,
            startCaptureTimeUs: segmentStartCaptureTimeUs(rally.activeSubmission),
          },
        ] as const,
      ]
    }),
  )
  for (const draft of drafts) {
    displayOrderByRallyId.set(draft.id, {
      displaySetNumber: effectiveSetNumberFor(draft.displaySetNumber),
      id: draft.id,
      startCaptureTimeUs: segmentStartCaptureTimeUs(draft),
    })
  }
  const displayOrdinalByRallyId = deriveRallyDisplayOrdinals([...displayOrderByRallyId.values()])
  const displayResultBySubmissionId = new Map(
    match.rallies.flatMap(rally => {
      const submission = rally.activeSubmission
      if (!submission) return []
      const displayAnalysis = selectDisplayAnalysis(
        submission.analysisRuns[0],
        submission.supersedes?.analysisRuns[0],
        submission.analysisSourceRun,
      )
      return [
        [
          submission.id,
          {
            analysis: displayAnalysis.analysis,
            clip:
              displayAnalysis.source === 'previous'
                ? (submission.supersedes?.clipJobs[0] ?? submission.clipJobs[0] ?? null)
                : (submission.clipJobs[0] ?? submission.supersedes?.clipJobs[0] ?? null),
          },
        ] as const,
      ]
    }),
  )
  const coverageByAnalysisId = new Map<string, CaptureCoverage | null>()
  const timelineByAnalysisId = new Map<string, ClipFrameTimeline>()
  const coverageTasks = match.rallies.flatMap(rally => {
    const submission = rally.activeSubmission
    const displayResult = submission ? displayResultBySubmissionId.get(submission.id) : null
    const analysis = displayResult?.analysis
    const clip = displayResult?.clip
    if (!analysis) return []
    const firstFrame = analysis.tracks.reduce<bigint | null>(
      (value, track) => (value === null || track.firstFrame < value ? track.firstFrame : value),
      null,
    )
    const lastFrame = analysis.tracks.reduce<bigint | null>(
      (value, track) => (value === null || track.lastFrame > value ? track.lastFrame : value),
      null,
    )
    return [
      async () => {
        if (!clip?.timingManifest || !dependencies.timingManifestReader) {
          coverageByAnalysisId.set(analysis.id, null)
          return
        }
        try {
          const timeline = await readClipFrameTimeline(
            dependencies.timingManifestReader,
            clip.timingManifest,
            timingManifestIdentity(clip.id, clip.idempotencyKey, clip.timingManifest.objectKey),
          )
          timelineByAnalysisId.set(analysis.id, timeline)
          coverageByAnalysisId.set(analysis.id, frameCoverage(timeline, firstFrame, lastFrame))
        } catch {
          coverageByAnalysisId.set(analysis.id, null)
        }
      },
    ]
  })
  for (let offset = 0; offset < coverageTasks.length; offset += 8) {
    await Promise.all(coverageTasks.slice(offset, offset + 8).map(task => task()))
  }
  const effectiveSides = (
    assignment: { leftTeamId: string; rightTeamId: string },
    reversed: boolean,
  ) =>
    reversed
      ? { leftTeamId: assignment.rightTeamId, rightTeamId: assignment.leftTeamId }
      : { leftTeamId: assignment.leftTeamId, rightTeamId: assignment.rightTeamId }
  const rallyProjection = (rally: (typeof match.rallies)[number]) => {
    const submission = rally.activeSubmission
    const sides = rally.sideAssignment
      ? effectiveSides(rally.sideAssignment, rally.sideAssignmentReversed)
      : {
          leftTeamId: submission?.leftTeamId ?? '',
          rightTeamId: submission?.rightTeamId ?? '',
        }
    const scoringTeamId = rally.scoringTeamId ?? submission?.scoringTeamId ?? null
    const scoringCourtSide =
      scoringTeamId === sides.leftTeamId
        ? ('left' as const)
        : scoringTeamId === sides.rightTeamId
          ? ('right' as const)
          : ((rally.scoringCourtSide?.toLowerCase() as 'left' | 'right' | undefined) ?? null)
    return {
      leftTeamId: sides.leftTeamId,
      rightTeamId: sides.rightTeamId,
      scoringCourtSide,
      scoringTeamId,
    }
  }
  const scoreByDisplaySet = new Map<number, Map<string, number>>()
  const runningScoreByRallyId = new Map<
    string,
    { left: number; right: number; winnerSide: 'left' | 'right' | null }
  >()
  for (const rally of [...match.rallies].sort(
    (left, right) =>
      effectiveSetNumberFor(left.displaySetNumber) -
        effectiveSetNumberFor(right.displaySetNumber) ||
      (displayOrdinalByRallyId.get(left.id) ?? 1) - (displayOrdinalByRallyId.get(right.id) ?? 1) ||
      left.id.localeCompare(right.id),
  )) {
    const effectiveSetNumber = effectiveSetNumberFor(rally.displaySetNumber)
    const teamScore = scoreByDisplaySet.get(effectiveSetNumber) ?? new Map<string, number>()
    const submission = rally.activeSubmission
    const projection = rallyProjection(rally)
    const scoringTeamId = projection.scoringTeamId
    const winnerSide =
      scoringTeamId && submission
        ? scoringTeamId === projection.leftTeamId
          ? ('left' as const)
          : scoringTeamId === projection.rightTeamId
            ? ('right' as const)
            : null
        : null
    if (submission?.scoreResolutionState === 'RESOLVED' && scoringTeamId) {
      teamScore.set(scoringTeamId, (teamScore.get(scoringTeamId) ?? 0) + 1)
    }
    scoreByDisplaySet.set(effectiveSetNumber, teamScore)
    runningScoreByRallyId.set(rally.id, {
      left: submission ? (teamScore.get(projection.leftTeamId) ?? 0) : 0,
      right: submission ? (teamScore.get(projection.rightTeamId) ?? 0) : 0,
      winnerSide,
    })
  }
  const dynamicSetScore = (set: (typeof match.sets)[number]) => {
    const teamScores =
      scoreByDisplaySet.get(effectiveSetNumberFor(set.setNumber)) ?? new Map<string, number>()
    const assignment = set.sideAssignments[0]
    return {
      left: assignment ? (teamScores.get(assignment.leftTeamId) ?? 0) : 0,
      right: assignment ? (teamScores.get(assignment.rightTeamId) ?? 0) : 0,
    }
  }
  return {
    schema_version: '1.0.0',
    match: {
      id: match.id,
      title: match.title,
      status: match.status.toLowerCase(),
      clip_pre_roll_us: match.clipPreRollUs.toString(),
      clip_post_roll_us: match.clipPostRollUs.toString(),
      teams: match.matchTeams.map(entry => entry.team),
      sets: match.sets.map(set => ({
        id: set.id,
        set_number: set.setNumber,
        status: set.status.toLowerCase(),
        left_score: dynamicSetScore(set).left,
        right_score: dynamicSetScore(set).right,
        score_revision: set.scoreRevision,
        winning_team_id: set.winningTeamId,
        side_assignment: set.sideAssignments[0]
          ? {
              id: set.sideAssignments[0].id,
              left_team_id: set.sideAssignments[0].leftTeamId,
              right_team_id: set.sideAssignments[0].rightTeamId,
            }
          : null,
      })),
      captures: match.captureSessions.map(capture => ({
        id: capture.id,
        source_kind: capture.sourceKind.toLowerCase(),
        source_label: capture.sourceLabel,
        status: capture.status.toLowerCase(),
        health: capture.health.toLowerCase(),
      })),
      drafts: drafts.map(draft => {
        const sides = effectiveSides(draft.sideAssignment, draft.sideAssignmentReversed)
        const scoringCourtSide =
          draft.scoringTeamId === sides.leftTeamId
            ? ('left' as const)
            : draft.scoringTeamId === sides.rightTeamId
              ? ('right' as const)
              : ((draft.scoringCourtSide?.toLowerCase() as 'left' | 'right' | undefined) ?? null)
        return {
          id: draft.id,
          ordinal: draft.ordinal,
          display_ordinal: displayOrdinalByRallyId.get(draft.id) ?? 1,
          display_set_number: draft.displaySetNumber,
          annotation_revision: draft.annotationRevision.toString(),
          annotation_status: draft.annotationStatus.toLowerCase(),
          active_submission_id: draft.activeSubmissionId,
          score_resolution: draft.scoreResolutionState.toLowerCase(),
          scoring_court_side: scoringCourtSide,
          scoring_team_id: draft.scoringTeamId,
          side_assignment_id: draft.sideAssignmentId,
          side_assignment_reversed: draft.sideAssignmentReversed,
          left_team_id: sides.leftTeamId,
          right_team_id: sides.rightTeamId,
          set_id: draft.set.id,
          set_number: draft.set.setNumber,
          key_points: draft.keyPoints.map(point => ({
            id: point.id,
            sequence_index: point.sequenceIndex,
            marker_kind: point.markerKind.toLowerCase(),
            is_terminal: point.isTerminal,
            capture_time_us: point.captureTimeUs.toString(),
            capture_frame_index: point.captureFrameIndex.toString(),
            ball_event: point.ballEvent
              ? {
                  kind: point.ballEvent.kind,
                  result: point.ballEvent.result,
                  serve_style: point.ballEvent.serveStyle,
                }
              : null,
          })),
          boundaries: draft.boundaries.map(boundary => ({
            kind: boundary.kind.toLowerCase(),
            capture_time_us: boundary.captureTimeUs.toString(),
            capture_frame_index: boundary.captureFrameIndex.toString(),
          })),
        }
      }),
      rallies: match.rallies.flatMap(rally =>
        rally.activeSubmission
          ? (() => {
              const projection = rallyProjection(rally)
              return [
                {
                  id: rally.id,
                  ordinal: rally.ordinal,
                  display_ordinal: displayOrdinalByRallyId.get(rally.id) ?? 1,
                  display_set_number: rally.displaySetNumber,
                  annotation_revision: rally.annotationRevision.toString(),
                  processing_status: rally.processingStatus.toLowerCase(),
                  scoring_court_side: projection.scoringCourtSide,
                  scoring_team_id: projection.scoringTeamId,
                  set_id: rally.set.id,
                  set_number: rally.set.setNumber,
                  left_score_after: runningScoreByRallyId.get(rally.id)?.left ?? 0,
                  right_score_after: runningScoreByRallyId.get(rally.id)?.right ?? 0,
                  winner_side: runningScoreByRallyId.get(rally.id)?.winnerSide ?? null,
                  submission: {
                    id: rally.activeSubmission.id,
                    supersedes_submission_id: rally.activeSubmission.supersedesSubmissionId,
                    submitted_at: rally.activeSubmission.submittedAt.toISOString(),
                    score_resolution: rally.activeSubmission.scoreResolutionState.toLowerCase(),
                    scoring_court_side: projection.scoringCourtSide,
                    scoring_team_id: projection.scoringTeamId,
                    side_assignment_id: rally.sideAssignmentId,
                    side_assignment_reversed: rally.sideAssignmentReversed,
                    left_team_id: projection.leftTeamId,
                    right_team_id: projection.rightTeamId,
                    contact_count: rally.activeSubmission.keyPoints.filter(
                      point => point.markerKind === 'CONTACT',
                    ).length,
                    key_points: rally.activeSubmission.keyPoints.map(point => ({
                      id: point.id,
                      sequence_index: point.sequenceIndex,
                      marker_kind: point.markerKind.toLowerCase(),
                      is_terminal: point.isTerminal,
                      capture_time_us: point.captureTimeUs.toString(),
                      capture_frame_index: point.captureFrameIndex.toString(),
                      ball_event: point.ballEvent
                        ? {
                            kind: point.ballEvent.kind,
                            result: point.ballEvent.result,
                            serve_style: point.ballEvent.serveStyle,
                          }
                        : null,
                    })),
                    boundaries: rally.activeSubmission.boundaries.map(boundary => ({
                      kind: boundary.kind.toLowerCase(),
                      capture_time_us: boundary.captureTimeUs.toString(),
                      capture_frame_index: boundary.captureFrameIndex.toString(),
                    })),
                    clip: (() => {
                      const clip = displayResultBySubmissionId.get(rally.activeSubmission.id)?.clip
                      return clip
                        ? {
                            id: clip.id,
                            status: clip.status.toLowerCase(),
                            start_capture_time_us: (
                              clip.actualStartCaptureUs ?? clip.requestedStartCaptureUs
                            ).toString(),
                            end_capture_time_us: (
                              clip.actualEndCaptureUs ?? clip.requestedEndCaptureUs
                            ).toString(),
                            duration_us: (
                              (clip.actualEndCaptureUs ?? clip.requestedEndCaptureUs) -
                              (clip.actualStartCaptureUs ?? clip.requestedStartCaptureUs)
                            ).toString(),
                          }
                        : null
                    })(),
                    processing: (() => {
                      const clip = rally.activeSubmission.clipJobs[0] ?? null
                      const aiJob = rally.activeSubmission.aiJobs[0] ?? null
                      const providerJob = aiJob?.providerJobId
                        ? (providerJobById.get(aiJob.providerJobId) ?? null)
                        : null
                      const effectiveJob = providerJob ?? aiJob
                      const processingStatus = rally.processingStatus.toLowerCase()
                      const clipFailed = clip?.status === 'FAILED'
                      const aiFailed = effectiveJob?.status === 'FAILED'
                      const failedJob = aiFailed ? effectiveJob : clipFailed ? clip : null
                      const failureSource = aiFailed ? 'ai' : clipFailed ? 'clip' : null
                      const stage =
                        processingStatus === 'completed'
                          ? 'completed'
                          : processingStatus === 'artifact_ingesting'
                            ? 'callback'
                            : processingStatus === 'ai_processing'
                              ? (aiJob?.stage ?? 'assigned')
                              : processingStatus === 'ai_queued'
                                ? providerJob?.status === 'RUNNING'
                                  ? (providerJob.stage ?? 'assigned')
                                  : effectiveJob?.providerInstance
                                    ? 'assigned'
                                    : 'waiting_worker'
                                : processingStatus === 'clip_queued' ||
                                    processingStatus === 'clipping'
                                  ? 'clipping'
                                  : processingStatus === 'failed'
                                    ? (aiJob?.stage ?? 'clipping')
                                    : processingStatus
                      const progress =
                        processingStatus === 'completed'
                          ? 1
                          : processingStatus === 'artifact_ingesting'
                            ? 0.96
                            : processingStatus === 'ai_processing'
                              ? (aiJob?.progress ?? 0.12)
                              : processingStatus === 'ai_queued'
                                ? providerJob?.status === 'RUNNING'
                                  ? (providerJob.progress ?? 0.12)
                                  : effectiveJob?.providerInstance
                                    ? 0.12
                                    : 0.1
                                : processingStatus === 'clip_queued' ||
                                    processingStatus === 'clipping'
                                  ? clip?.status === 'RUNNING'
                                    ? 0.06
                                    : 0.02
                                  : processingStatus === 'failed'
                                    ? (aiJob?.progress ?? 0.06)
                                    : 0
                      return {
                        schema_version: '2.0.0',
                        type: 'rally_processing_update',
                        room_id: `match:${match.id}:capture:${rally.program.captureSessionId}`,
                        rally_id: rally.id,
                        submission_id: rally.activeSubmission.id,
                        processing_status: processingStatus,
                        ai_job_id: aiJob?.id ?? null,
                        worker_instance_key: effectiveJob?.providerInstance?.instanceKey ?? null,
                        provider_build_id: effectiveJob?.providerInstance?.providerBuildId ?? null,
                        progress,
                        stage,
                        updated_at: (
                          effectiveJob?.updatedAt ??
                          clip?.updatedAt ??
                          rally.activeSubmission.submittedAt
                        ).toISOString(),
                        analysis_id:
                          displayResultBySubmissionId.get(rally.activeSubmission.id)?.analysis
                            ?.id ?? null,
                        analysis_data_version: null,
                        error: failedJob
                          ? {
                              code: failedJob.errorCode ?? 'PROCESSING_FAILED',
                              message: failedJob.errorMessage ?? '處理工作失敗',
                              source: failureSource,
                              attempt_count: failedJob.attemptCount,
                              max_attempts: failedJob.maxAttempts,
                              job_id: failedJob.id,
                            }
                          : null,
                      }
                    })(),
                    analysis: displayResultBySubmissionId.get(rally.activeSubmission.id)?.analysis
                      ? (() => {
                          const analysis = displayResultBySubmissionId.get(
                            rally.activeSubmission.id,
                          )!.analysis!
                          const coverage = coverageByAnalysisId.get(analysis.id) ?? null
                          const frameTimeline = timelineByAnalysisId.get(analysis.id)
                          const timeByContact = new Map(
                            analysis.contactTimeCorrections.map(item => [
                              item.keyPointId,
                              item.frameIndex,
                            ]),
                          )
                          const editByContact = new Map(
                            analysis.contactEdits.map(item => [item.contactId, item]),
                          )
                          const effectiveContacts = [
                            ...analysis.contactEvents.flatMap(event =>
                              editByContact.get(event.keyPointId)?.deleted
                                ? []
                                : [
                                    {
                                      id: event.keyPointId,
                                      frameIndex: resolveEffectiveContactFrame(
                                        event,
                                        timeByContact,
                                      ),
                                      source:
                                        event.anchorOrigin === 'ai_detected'
                                          ? ('ai' as const)
                                          : ('human' as const),
                                      confidence: event.detectionConfidence,
                                    },
                                  ],
                            ),
                            ...analysis.contactEdits.flatMap(edit =>
                              !edit.baseKeyPointId && !edit.deleted
                                ? [
                                    {
                                      id: edit.contactId,
                                      frameIndex:
                                        timeByContact.get(edit.contactId) ?? edit.frameIndex,
                                      source: 'manual' as const,
                                      confidence: null,
                                    },
                                  ]
                                : [],
                            ),
                          ].sort((left, right) =>
                            left.frameIndex < right.frameIndex
                              ? -1
                              : left.frameIndex > right.frameIndex
                                ? 1
                                : left.id.localeCompare(right.id),
                          )
                          const byteLength = [
                            analysis.rawAnalysisDataAsset?.byteLength,
                            ...analysis.artifacts.map(artifact => artifact.asset.byteLength),
                            ...(analysis.analysisDataManifest?.chunks.map(
                              chunk => chunk.byteLength,
                            ) ?? []),
                          ].reduce<bigint>((total, value) => total + (value ?? 0n), 0n)
                          const capabilities = [
                            analysis._count.tracks > 0 ? 'player_tracking' : null,
                            analysis._count.segments > 0 ? 'ball_tracking' : null,
                            analysis._count.contactEvents > 0 ? 'contact_association' : null,
                            analysis.analysisDataManifest ? 'analysis_data' : null,
                          ].filter((value): value is string => value !== null)
                          return {
                            id: analysis.id,
                            status: analysis.status.toLowerCase(),
                            version: analysis.analysisVersion,
                            summary: analysis.summary,
                            identity_mapping_completed: Boolean(
                              analysis.identityMappingCompletedAt,
                            ),
                            coverage_start_capture_time_us: coverage?.startUs.toString() ?? null,
                            coverage_end_capture_time_us: coverage?.endUs.toString() ?? null,
                            byte_length: byteLength.toString(),
                            track_count: analysis._count.tracks,
                            ball_path_count: analysis._count.segments,
                            contact_count: effectiveContacts.length,
                            contact_points: effectiveContacts.flatMap(contact => {
                              if (
                                !frameTimeline ||
                                contact.frameIndex < 0n ||
                                contact.frameIndex >= BigInt(frameTimeline.captureTimeUs.length)
                              )
                                return []
                              return [
                                {
                                  id: contact.id,
                                  capture_time_us:
                                    frameTimeline.captureTimeUs[
                                      Number(contact.frameIndex)
                                    ]!.toString(),
                                  frame_index: contact.frameIndex.toString(),
                                  source: contact.source,
                                  confidence: contact.confidence,
                                },
                              ]
                            }),
                            capabilities,
                          }
                        })()
                      : null,
                  },
                },
              ]
            })()
          : [],
      ),
    },
  }
}
