import type { PrismaClient } from '@volleyball-monitoring/db'
import { AnnotationStatus, UserRole } from '@volleyball-monitoring/db/client'

export async function getCoachMatchState(
  database: PrismaClient,
  input: { matchId: string; userId: string; role: UserRole },
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
        take: 100,
        select: {
          id: true, ordinal: true, annotationRevision: true, processingStatus: true, scoringCourtSide: true, scoringTeamId: true,
          set: { select: { id: true, setNumber: true } },
          activeSubmission: {
            select: {
              id: true, submittedAt: true, scoreResolutionState: true, scoringCourtSide: true, scoringTeamId: true,
              keyPoints: {
                orderBy: { sequenceIndex: 'asc' },
                select: { id: true, sequenceIndex: true, markerKind: true, isTerminal: true, captureTimeUs: true, captureFrameIndex: true },
              },
              clipJobs: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, actualStartCaptureUs: true, actualEndCaptureUs: true, requestedStartCaptureUs: true, requestedEndCaptureUs: true } },
              analysisRuns: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: {
                  id: true, status: true, analysisVersion: true, summary: true, identityMappingCompletedAt: true,
                  rawAnalysisAsset: { select: { byteLength: true } },
                  rawOverlayAsset: { select: { byteLength: true } },
                  artifacts: { select: { asset: { select: { byteLength: true } } } },
                  overlayManifest: { select: { fpsNum: true, fpsDen: true, chunks: { select: { byteLength: true } } } },
                  tracks: { select: { firstFrame: true, lastFrame: true } },
                  _count: { select: { tracks: true, segments: true, contactEvents: true } },
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
        id: rally.id, ordinal: rally.ordinal, annotation_revision: rally.annotationRevision.toString(), processing_status: rally.processingStatus.toLowerCase(), scoring_court_side: rally.scoringCourtSide?.toLowerCase() ?? null, scoring_team_id: rally.scoringTeamId, set_id: rally.set.id, set_number: rally.set.setNumber,
        submission: {
          id: rally.activeSubmission.id, submitted_at: rally.activeSubmission.submittedAt.toISOString(), score_resolution: rally.activeSubmission.scoreResolutionState.toLowerCase(), scoring_court_side: rally.activeSubmission.scoringCourtSide?.toLowerCase() ?? null, scoring_team_id: rally.activeSubmission.scoringTeamId,
          contact_count: rally.activeSubmission.keyPoints.filter(point => point.markerKind === 'CONTACT').length,
          key_points: rally.activeSubmission.keyPoints.map(point => ({
            id: point.id,
            sequence_index: point.sequenceIndex,
            marker_kind: point.markerKind.toLowerCase(),
            is_terminal: point.isTerminal,
            capture_time_us: point.captureTimeUs.toString(),
            capture_frame_index: point.captureFrameIndex.toString(),
          })),
          clip: rally.activeSubmission.clipJobs[0] ? {
            id: rally.activeSubmission.clipJobs[0].id,
            status: rally.activeSubmission.clipJobs[0].status.toLowerCase(),
            start_capture_time_us: (rally.activeSubmission.clipJobs[0].actualStartCaptureUs ?? rally.activeSubmission.clipJobs[0].requestedStartCaptureUs).toString(),
            end_capture_time_us: (rally.activeSubmission.clipJobs[0].actualEndCaptureUs ?? rally.activeSubmission.clipJobs[0].requestedEndCaptureUs).toString(),
            duration_us: ((rally.activeSubmission.clipJobs[0].actualEndCaptureUs ?? rally.activeSubmission.clipJobs[0].requestedEndCaptureUs)
              - (rally.activeSubmission.clipJobs[0].actualStartCaptureUs ?? rally.activeSubmission.clipJobs[0].requestedStartCaptureUs)).toString(),
          } : null,
          analysis: rally.activeSubmission.analysisRuns[0] ? (() => {
            const analysis = rally.activeSubmission.analysisRuns[0]
            const clip = rally.activeSubmission.clipJobs[0]
            const clipStart = clip ? (clip.actualStartCaptureUs ?? clip.requestedStartCaptureUs) : null
            const clipEnd = clip ? (clip.actualEndCaptureUs ?? clip.requestedEndCaptureUs) : null
            const firstFrame = analysis.tracks.reduce<bigint | null>((value, track) => value === null || track.firstFrame < value ? track.firstFrame : value, null)
            const lastFrame = analysis.tracks.reduce<bigint | null>((value, track) => value === null || track.lastFrame > value ? track.lastFrame : value, null)
            const fpsNum = BigInt(analysis.overlayManifest?.fpsNum ?? 0)
            const fpsDen = BigInt(analysis.overlayManifest?.fpsDen ?? 1)
            const frameToCapture = (frame: bigint | null) => frame === null || clipStart === null || fpsNum <= 0n
              ? null
              : clipStart + frame * 1_000_000n * fpsDen / fpsNum
            const rawCoverageStart = frameToCapture(firstFrame)
            const rawCoverageEnd = frameToCapture(lastFrame === null ? null : lastFrame + 1n)
            const coverageStart = rawCoverageStart === null ? clipStart : clipStart !== null && rawCoverageStart < clipStart ? clipStart : rawCoverageStart
            const coverageEnd = rawCoverageEnd === null ? clipEnd : clipEnd !== null && rawCoverageEnd > clipEnd ? clipEnd : rawCoverageEnd
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
              coverage_start_capture_time_us: coverageStart?.toString() ?? null,
              coverage_end_capture_time_us: coverageEnd?.toString() ?? null,
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
