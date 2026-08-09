import type { PrismaClient } from '@volleyball-monitoring/db'
import { AnnotationStatus, UserRole } from '@volleyball-monitoring/db/client'
import {
  readClipTimingCoverage,
  type CaptureCoverage,
} from '../media/clip-timing-coverage.js'
import type { MediaObjectReader } from '../media/playback-domain.js'

interface CoachDashboardDependencies {
  timingManifestReader?: MediaObjectReader
}

const dashboardClipSelect = {
  id: true,
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
  id: true, status: true, analysisVersion: true, summary: true, identityMappingCompletedAt: true,
  rawAnalysisAsset: { select: { byteLength: true } },
  rawOverlayAsset: { select: { byteLength: true } },
  artifacts: { select: { asset: { select: { byteLength: true } } } },
  overlayManifest: { select: { fpsNum: true, fpsDen: true, chunks: { select: { byteLength: true } } } },
  tracks: { select: { firstFrame: true, lastFrame: true } },
  _count: { select: { tracks: true, segments: true, contactEvents: true } },
} as const

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
      id: true, title: true, status: true, clipPreRollUs: true, clipPostRollUs: true,
      matchTeams: { select: { team: { select: { id: true, name: true, shortName: true } } } },
      sets: {
        orderBy: { setNumber: 'asc' },
        select: {
          id: true, setNumber: true, status: true, leftScore: true, rightScore: true, scoreRevision: true, winningTeamId: true,
          sideAssignments: { where: { effectiveToRallyOrdinal: null }, orderBy: { effectiveFromRallyOrdinal: 'desc' }, take: 1, select: { id: true, leftTeamId: true, rightTeamId: true } },
        },
      },
      captureSessions: { orderBy: { createdAt: 'desc' }, select: { id: true, sourceKind: true, sourceLabel: true, status: true, health: true } },
      rallies: {
        where: { activeSubmissionId: { not: null }, voidedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true, ordinal: true, displayOrdinal: true, displaySetNumber: true, annotationRevision: true, processingStatus: true, scoringCourtSide: true, scoringTeamId: true,
          set: { select: { id: true, setNumber: true } },
          program: { select: { captureSessionId: true } },
          activeSubmission: {
            select: {
              id: true, submittedAt: true, scoreResolutionState: true, scoringCourtSide: true, scoringTeamId: true, supersedesSubmissionId: true,
              keyPoints: {
                orderBy: { sequenceIndex: 'asc' },
                select: { id: true, sequenceIndex: true, markerKind: true, isTerminal: true, captureTimeUs: true, captureFrameIndex: true },
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
                  providerInstance: { select: { instanceKey: true, providerBuildId: true } },
                },
              },
              analysisRuns: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: dashboardAnalysisSelect,
              },
              supersedes: {
                select: {
                  clipJobs: { where: { status: 'COMPLETED' }, orderBy: { completedAt: 'desc' }, take: 1, select: dashboardClipSelect },
                  analysisRuns: { where: { status: 'COMPLETED' }, orderBy: { activatedAt: 'desc' }, take: 1, select: dashboardAnalysisSelect },
                },
              },
            },
          },
        },
      },
    },
  })
  if (!match) return null
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
      displayOrdinal: true,
      displaySetNumber: true,
      annotationRevision: true,
      annotationStatus: true,
      activeSubmissionId: true,
      set: { select: { id: true, setNumber: true } },
      keyPoints: {
        where: { deletedAt: null },
        orderBy: { sequenceIndex: 'asc' },
        select: { id: true, sequenceIndex: true, markerKind: true, isTerminal: true, captureTimeUs: true, captureFrameIndex: true },
      },
    },
  })
  const displayResultBySubmissionId = new Map(match.rallies.flatMap((rally) => {
    const submission = rally.activeSubmission
    if (!submission) return []
    const activeAnalysis = submission.analysisRuns[0] ?? null
    return [[submission.id, {
      analysis: activeAnalysis ?? submission.supersedes?.analysisRuns[0] ?? null,
      clip: activeAnalysis
        ? submission.clipJobs[0] ?? null
        : submission.supersedes?.clipJobs[0] ?? submission.clipJobs[0] ?? null,
    }] as const]
  }))
  const coverageByAnalysisId = new Map<string, CaptureCoverage | null>()
  const coverageTasks = match.rallies.flatMap((rally) => {
    const submission = rally.activeSubmission
    const displayResult = submission ? displayResultBySubmissionId.get(submission.id) : null
    const analysis = displayResult?.analysis
    const clip = displayResult?.clip
    if (!analysis) return []
    const firstFrame = analysis.tracks.reduce<bigint | null>(
      (value, track) => value === null || track.firstFrame < value
        ? track.firstFrame
        : value,
      null,
    )
    const lastFrame = analysis.tracks.reduce<bigint | null>(
      (value, track) => value === null || track.lastFrame > value
        ? track.lastFrame
        : value,
      null,
    )
    return [async () => {
      if (!clip?.timingManifest || !dependencies.timingManifestReader) {
        coverageByAnalysisId.set(analysis.id, null)
        return
      }
      try {
        coverageByAnalysisId.set(
          analysis.id,
          await readClipTimingCoverage(
            dependencies.timingManifestReader,
            clip.timingManifest,
            clip.id,
            firstFrame,
            lastFrame,
          ),
        )
      } catch {
        coverageByAnalysisId.set(analysis.id, null)
      }
    }]
  })
  for (let offset = 0; offset < coverageTasks.length; offset += 8) {
    await Promise.all(coverageTasks.slice(offset, offset + 8).map(task => task()))
  }
  const scoreByDisplaySet = new Map<number, { left: number; right: number }>()
  const runningScoreByRallyId = new Map<string, { left: number; right: number; winnerSide: 'left' | 'right' | null }>()
  const assignmentsBySetNumber = new Map(match.sets.map(set => [set.setNumber, set.sideAssignments[0] ?? null]))
  for (const rally of [...match.rallies].sort((left, right) =>
    left.displaySetNumber - right.displaySetNumber
    || left.displayOrdinal - right.displayOrdinal
    || left.id.localeCompare(right.id),
  )) {
    const score = scoreByDisplaySet.get(rally.displaySetNumber) ?? { left: 0, right: 0 }
    const assignment = assignmentsBySetNumber.get(rally.displaySetNumber)
    const scoringTeamId = rally.activeSubmission?.scoringTeamId ?? rally.scoringTeamId
    const winnerSide = scoringTeamId && assignment
      ? scoringTeamId === assignment.leftTeamId
        ? 'left' as const
        : scoringTeamId === assignment.rightTeamId
          ? 'right' as const
          : null
      : null
    if (winnerSide === 'left') score.left += 1
    if (winnerSide === 'right') score.right += 1
    scoreByDisplaySet.set(rally.displaySetNumber, score)
    runningScoreByRallyId.set(rally.id, { ...score, winnerSide })
  }
  return {
    schema_version: '1.0.0',
    match: {
      id: match.id, title: match.title, status: match.status.toLowerCase(), clip_pre_roll_us: match.clipPreRollUs.toString(), clip_post_roll_us: match.clipPostRollUs.toString(),
      teams: match.matchTeams.map(entry => entry.team),
      sets: match.sets.map(set => ({
        id: set.id, set_number: set.setNumber, status: set.status.toLowerCase(), left_score: set.leftScore, right_score: set.rightScore, score_revision: set.scoreRevision, winning_team_id: set.winningTeamId,
        side_assignment: set.sideAssignments[0] ? { id: set.sideAssignments[0].id, left_team_id: set.sideAssignments[0].leftTeamId, right_team_id: set.sideAssignments[0].rightTeamId } : null,
      })),
      captures: match.captureSessions.map(capture => ({ id: capture.id, source_kind: capture.sourceKind.toLowerCase(), source_label: capture.sourceLabel, status: capture.status.toLowerCase(), health: capture.health.toLowerCase() })),
      drafts: drafts.map(draft => ({
        id: draft.id,
        ordinal: draft.ordinal,
        display_ordinal: draft.displayOrdinal,
        display_set_number: draft.displaySetNumber,
        annotation_revision: draft.annotationRevision.toString(),
        annotation_status: draft.annotationStatus.toLowerCase(),
        active_submission_id: draft.activeSubmissionId,
        set_id: draft.set.id,
        set_number: draft.set.setNumber,
        key_points: draft.keyPoints.map(point => ({
          id: point.id,
          sequence_index: point.sequenceIndex,
          marker_kind: point.markerKind.toLowerCase(),
          is_terminal: point.isTerminal,
          capture_time_us: point.captureTimeUs.toString(),
          capture_frame_index: point.captureFrameIndex.toString(),
        })),
      })),
      rallies: match.rallies.flatMap(rally => rally.activeSubmission ? [{
        id: rally.id, ordinal: rally.ordinal, display_ordinal: rally.displayOrdinal, display_set_number: rally.displaySetNumber, annotation_revision: rally.annotationRevision.toString(), processing_status: rally.processingStatus.toLowerCase(), scoring_court_side: rally.scoringCourtSide?.toLowerCase() ?? null, scoring_team_id: rally.scoringTeamId, set_id: rally.set.id, set_number: rally.set.setNumber,
        left_score_after: runningScoreByRallyId.get(rally.id)?.left ?? 0,
        right_score_after: runningScoreByRallyId.get(rally.id)?.right ?? 0,
        winner_side: runningScoreByRallyId.get(rally.id)?.winnerSide ?? null,
        submission: {
          id: rally.activeSubmission.id, supersedes_submission_id: rally.activeSubmission.supersedesSubmissionId, submitted_at: rally.activeSubmission.submittedAt.toISOString(), score_resolution: rally.activeSubmission.scoreResolutionState.toLowerCase(), scoring_court_side: rally.activeSubmission.scoringCourtSide?.toLowerCase() ?? null, scoring_team_id: rally.activeSubmission.scoringTeamId,
          contact_count: rally.activeSubmission.keyPoints.filter(point => point.markerKind === 'CONTACT').length,
          key_points: rally.activeSubmission.keyPoints.map(point => ({
            id: point.id,
            sequence_index: point.sequenceIndex,
            marker_kind: point.markerKind.toLowerCase(),
            is_terminal: point.isTerminal,
            capture_time_us: point.captureTimeUs.toString(),
            capture_frame_index: point.captureFrameIndex.toString(),
          })),
          clip: (() => {
            const clip = displayResultBySubmissionId.get(rally.activeSubmission.id)?.clip
            return clip ? {
              id: clip.id,
              status: clip.status.toLowerCase(),
              start_capture_time_us: (clip.actualStartCaptureUs ?? clip.requestedStartCaptureUs).toString(),
              end_capture_time_us: (clip.actualEndCaptureUs ?? clip.requestedEndCaptureUs).toString(),
              duration_us: ((clip.actualEndCaptureUs ?? clip.requestedEndCaptureUs)
                - (clip.actualStartCaptureUs ?? clip.requestedStartCaptureUs)).toString(),
            } : null
          })(),
          processing: (() => {
            const clip = rally.activeSubmission.clipJobs[0] ?? null
            const aiJob = rally.activeSubmission.aiJobs[0] ?? null
            const processingStatus = rally.processingStatus.toLowerCase()
            const clipFailed = clip?.status === 'FAILED'
            const aiFailed = aiJob?.status === 'FAILED'
            const failedJob = aiFailed ? aiJob : clipFailed ? clip : null
            const failureSource = aiFailed ? 'ai' : clipFailed ? 'clip' : null
            const stage = processingStatus === 'completed'
              ? 'completed'
              : processingStatus === 'artifact_ingesting'
                ? 'callback'
                : processingStatus === 'ai_processing'
                  ? aiJob?.stage ?? 'assigned'
                  : processingStatus === 'ai_queued'
                    ? aiJob?.providerInstance ? 'assigned' : 'waiting_worker'
                    : processingStatus === 'clip_queued' || processingStatus === 'clipping'
                      ? 'clipping'
                      : processingStatus === 'failed'
                        ? aiJob?.stage ?? 'clipping'
                        : processingStatus
            const progress = processingStatus === 'completed'
              ? 1
              : processingStatus === 'artifact_ingesting'
                ? 0.96
                : processingStatus === 'ai_processing'
                  ? aiJob?.progress ?? 0.12
                  : processingStatus === 'ai_queued'
                    ? aiJob?.providerInstance ? 0.12 : 0.1
                    : processingStatus === 'clip_queued' || processingStatus === 'clipping'
                      ? clip?.status === 'RUNNING' ? 0.06 : 0.02
                      : processingStatus === 'failed'
                        ? aiJob?.progress ?? 0.06
                        : 0
            return {
              schema_version: '2.0.0',
              type: 'rally_processing_update',
              room_id: `match:${match.id}:capture:${rally.program.captureSessionId}`,
              rally_id: rally.id,
              submission_id: rally.activeSubmission.id,
              processing_status: processingStatus,
              ai_job_id: aiJob?.id ?? null,
              worker_instance_key: aiJob?.providerInstance?.instanceKey ?? null,
              provider_build_id: aiJob?.providerInstance?.providerBuildId ?? null,
              progress,
              stage,
              updated_at: (aiJob?.updatedAt ?? clip?.updatedAt ?? rally.activeSubmission.submittedAt).toISOString(),
              analysis_id: displayResultBySubmissionId.get(rally.activeSubmission.id)?.analysis?.id ?? null,
              overlay_version: null,
              error: failedJob ? {
                code: failedJob.errorCode ?? 'PROCESSING_FAILED',
                message: failedJob.errorMessage ?? '處理工作失敗',
                source: failureSource,
                attempt_count: failedJob.attemptCount,
                max_attempts: failedJob.maxAttempts,
                job_id: failedJob.id,
              } : null,
            }
          })(),
          analysis: displayResultBySubmissionId.get(rally.activeSubmission.id)?.analysis ? (() => {
            const analysis = displayResultBySubmissionId.get(rally.activeSubmission.id)!.analysis!
            const coverage = coverageByAnalysisId.get(analysis.id) ?? null
            const byteLength = [
              analysis.rawAnalysisAsset?.byteLength,
              analysis.rawOverlayAsset?.byteLength,
              ...analysis.artifacts.map(artifact => artifact.asset.byteLength),
              ...(analysis.overlayManifest?.chunks.map(chunk => chunk.byteLength) ?? []),
            ].reduce<bigint>((total, value) => total + (value ?? 0n), 0n)
            const capabilities = [
              analysis._count.tracks > 0 ? 'player_tracking' : null,
              analysis._count.segments > 0 ? 'ball_tracking' : null,
              analysis._count.contactEvents > 0 ? 'contact_association' : null,
              analysis.overlayManifest ? 'overlay' : null,
            ].filter((value): value is string => value !== null)
            return {
              id: analysis.id,
              status: analysis.status.toLowerCase(),
              version: analysis.analysisVersion,
              summary: analysis.summary,
              identity_mapping_completed: Boolean(analysis.identityMappingCompletedAt),
              coverage_start_capture_time_us: coverage?.startUs.toString() ?? null,
              coverage_end_capture_time_us: coverage?.endUs.toString() ?? null,
              byte_length: byteLength.toString(),
              track_count: analysis._count.tracks,
              ball_path_count: analysis._count.segments,
              contact_count: analysis._count.contactEvents,
              capabilities,
            }
          })() : null,
        },
      }] : []),
    },
  }
}
