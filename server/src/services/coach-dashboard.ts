import type { PrismaClient } from '@volleyball-monitoring/db'
import { UserRole } from '@volleyball-monitoring/db/client'

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
      id: true, title: true, status: true,
      matchTeams: { select: { team: { select: { id: true, name: true, shortName: true } } } },
      sets: {
        orderBy: { setNumber: 'asc' },
        select: {
          id: true, setNumber: true, status: true, leftScore: true, rightScore: true, scoreRevision: true,
          sideAssignments: { where: { effectiveToRallyOrdinal: null }, orderBy: { effectiveFromRallyOrdinal: 'desc' }, take: 1, select: { id: true, leftTeamId: true, rightTeamId: true } },
        },
      },
      captureSessions: { orderBy: { createdAt: 'desc' }, select: { id: true, sourceLabel: true, status: true, health: true } },
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
              keyPoints: { where: { markerKind: 'CONTACT' }, select: { id: true } },
              clipJobs: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, actualStartCaptureUs: true, actualEndCaptureUs: true, requestedStartCaptureUs: true, requestedEndCaptureUs: true } },
              analysisRuns: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, analysisVersion: true, summary: true, identityMappingCompletedAt: true } },
            },
          },
        },
      },
    },
  })
  if (!match) return null
  return {
    schema_version: '1.0.0',
    match: {
      id: match.id, title: match.title, status: match.status.toLowerCase(),
      teams: match.matchTeams.map(entry => entry.team),
      sets: match.sets.map(set => ({
        id: set.id, set_number: set.setNumber, status: set.status.toLowerCase(), left_score: set.leftScore, right_score: set.rightScore, score_revision: set.scoreRevision,
        side_assignment: set.sideAssignments[0] ? { id: set.sideAssignments[0].id, left_team_id: set.sideAssignments[0].leftTeamId, right_team_id: set.sideAssignments[0].rightTeamId } : null,
      })),
      captures: match.captureSessions.map(capture => ({ id: capture.id, source_label: capture.sourceLabel, status: capture.status.toLowerCase(), health: capture.health.toLowerCase() })),
      rallies: match.rallies.flatMap(rally => rally.activeSubmission ? [{
        id: rally.id, ordinal: rally.ordinal, annotation_revision: rally.annotationRevision.toString(), processing_status: rally.processingStatus.toLowerCase(), scoring_court_side: rally.scoringCourtSide?.toLowerCase() ?? null, scoring_team_id: rally.scoringTeamId, set_id: rally.set.id, set_number: rally.set.setNumber,
        submission: {
          id: rally.activeSubmission.id, submitted_at: rally.activeSubmission.submittedAt.toISOString(), score_resolution: rally.activeSubmission.scoreResolutionState.toLowerCase(), scoring_court_side: rally.activeSubmission.scoringCourtSide?.toLowerCase() ?? null, scoring_team_id: rally.activeSubmission.scoringTeamId,
          contact_count: rally.activeSubmission.keyPoints.length,
          clip: rally.activeSubmission.clipJobs[0] ? {
            id: rally.activeSubmission.clipJobs[0].id,
            status: rally.activeSubmission.clipJobs[0].status.toLowerCase(),
            start_capture_time_us: (rally.activeSubmission.clipJobs[0].actualStartCaptureUs ?? rally.activeSubmission.clipJobs[0].requestedStartCaptureUs).toString(),
            end_capture_time_us: (rally.activeSubmission.clipJobs[0].actualEndCaptureUs ?? rally.activeSubmission.clipJobs[0].requestedEndCaptureUs).toString(),
            duration_us: ((rally.activeSubmission.clipJobs[0].actualEndCaptureUs ?? rally.activeSubmission.clipJobs[0].requestedEndCaptureUs)
              - (rally.activeSubmission.clipJobs[0].actualStartCaptureUs ?? rally.activeSubmission.clipJobs[0].requestedStartCaptureUs)).toString(),
          } : null,
          analysis: rally.activeSubmission.analysisRuns[0] ? { id: rally.activeSubmission.analysisRuns[0].id, status: rally.activeSubmission.analysisRuns[0].status.toLowerCase(), version: rally.activeSubmission.analysisRuns[0].analysisVersion, summary: rally.activeSubmission.analysisRuns[0].summary, identity_mapping_completed: Boolean(rally.activeSubmission.analysisRuns[0].identityMappingCompletedAt) } : null,
        },
      }] : []),
    },
  }
}
