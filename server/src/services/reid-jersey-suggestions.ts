import type { PrismaClient } from '@volleyball-monitoring/db'
import { ArtifactState, JobStatus, UserRole } from '@volleyball-monitoring/db/client'
import { GraphQLError } from 'graphql'
import { assignTrackIdentity } from './coach-analytics.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function assertEditorRole(role: UserRole) {
  if (role !== UserRole.ADMIN && role !== UserRole.OPERATOR && role !== UserRole.COACH)
    throw new Error('FORBIDDEN')
}

async function assertMatchAccess(
  database: PrismaClient,
  input: { matchId: string; userId: string; role: UserRole },
) {
  if (input.role === UserRole.ADMIN) return
  const member = await database.matchMember.findUnique({
    where: { matchId_userId: { matchId: input.matchId, userId: input.userId } },
    select: { userId: true },
  })
  if (!member) throw new Error('NOT_FOUND')
}

export async function requestReidJerseySuggestions(
  database: PrismaClient,
  input: { runId: string; analysisRunId: string; userId: string; role: UserRole },
) {
  assertEditorRole(input.role)
  if (!UUID_PATTERN.test(input.runId))
    throw new GraphQLError('runId 必須是 UUID', { extensions: { code: 'BAD_USER_INPUT' } })
  const analysis = await database.analysisRun.findUnique({
    where: { id: input.analysisRunId },
    select: {
      submission: { select: { rally: { select: { matchId: true } } } },
      aiJob: { select: { clipJob: { select: { clipAsset: { select: { state: true } } } } } },
      personPoseEvidenceManifests: {
        where: { status: ArtifactState.READY },
        select: { id: true },
        take: 1,
      },
      reidEvidenceSets: {
        where: { status: ArtifactState.READY, supersededAt: null },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { tracklets: { select: { id: true } } },
      },
    },
  })
  if (!analysis) throw new Error('NOT_FOUND')
  await assertMatchAccess(database, {
    matchId: analysis.submission.rally.matchId,
    userId: input.userId,
    role: input.role,
  })
  const tracklets = analysis.reidEvidenceSets[0]?.tracklets ?? []
  if (
    analysis.aiJob.clipJob.clipAsset?.state !== ArtifactState.READY ||
    analysis.personPoseEvidenceManifests.length === 0 ||
    tracklets.length === 0
  )
    throw new GraphQLError('背號感知需要已完成的影片、逐 frame pose 與 ReID Local evidence', {
      extensions: { code: 'JERSEY_SUGGESTION_INPUT_PENDING' },
    })
  const existing = await database.reidJerseySuggestionRun.findUnique({ where: { id: input.runId } })
  if (existing) {
    if (
      existing.analysisRunId !== input.analysisRunId ||
      existing.requestedByUserId !== input.userId
    )
      throw new GraphQLError('runId 已被其他請求使用', { extensions: { code: 'CONFLICT' } })
    return { run_id: existing.id, match_id: analysis.submission.rally.matchId }
  }
  await database.reidJerseySuggestionRun.create({
    data: {
      id: input.runId,
      analysisRunId: input.analysisRunId,
      requestedByUserId: input.userId,
      suggestions: {
        create: tracklets.map(tracklet => ({ trackletId: tracklet.id })),
      },
    },
  })
  return { run_id: input.runId, match_id: analysis.submission.rally.matchId }
}

export async function getReidJerseySuggestionRun(
  database: PrismaClient,
  input: { runId: string; userId: string; role: UserRole },
) {
  assertEditorRole(input.role)
  const run = await database.reidJerseySuggestionRun.findUnique({
    where: { id: input.runId },
    include: {
      analysisRun: { select: { submission: { select: { rally: { select: { matchId: true } } } } } },
      suggestions: {
        orderBy: { tracklet: { canonicalTrackId: 'asc' } },
        include: {
          tracklet: {
            include: {
              activeProjection: {
                include: {
                  assignmentRevision: {
                    include: { rosterEntry: true, personCluster: true },
                  },
                },
              },
              previews: {
                where: { status: ArtifactState.READY },
                orderBy: { createdAt: 'desc' },
                take: 1,
              },
            },
          },
          suggestedRosterEntry: true,
        },
      },
    },
  })
  if (!run) return null
  const matchId = run.analysisRun.submission.rally.matchId
  await assertMatchAccess(database, { matchId, userId: input.userId, role: input.role })
  return {
    schema_version: '1.0.0',
    run_id: run.id,
    analysis_run_id: run.analysisRunId,
    match_id: matchId,
    status: run.status,
    model_namespace: run.modelNamespace,
    error_message: run.errorMessage,
    created_at: run.createdAt.toISOString(),
    started_at: run.startedAt?.toISOString() ?? null,
    completed_at: run.completedAt?.toISOString() ?? null,
    items: run.suggestions.map(item => {
      const assignment = item.tracklet.activeProjection?.assignmentRevision
      const current = assignment?.rosterEntry
      const suggested = item.suggestedRosterEntry
      return {
        suggestion_id: item.id,
        tracklet_id: item.trackletId,
        track_id: item.tracklet.canonicalTrackId,
        gid_id: assignment?.personClusterId ?? null,
        gid_label: assignment?.personCluster?.label ?? null,
        status: item.status,
        current_roster_entry_id: current?.id ?? null,
        current_jersey_number: current?.jerseyNumber ?? null,
        current_player_name: current?.displayNameSnapshot ?? null,
        suggested_roster_entry_id: suggested?.id ?? null,
        suggested_jersey_number: item.suggestedJerseyNumber,
        suggested_player_name: suggested?.displayNameSnapshot ?? null,
        confidence: item.confidence,
        alternatives: item.alternatives,
        selected_frame_indices: item.selectedFrameIndices.map(String),
        montage_url: item.montageAssetId
          ? `/api/v1/reid/jersey-suggestions/${item.id}/montage`
          : null,
        preview_url: item.tracklet.previews[0]
          ? `/api/v1/reid/previews/${item.tracklet.previews[0].id}`
          : null,
        changed: Boolean(suggested?.id && suggested.id !== current?.id),
        applied_at: item.appliedAt?.toISOString() ?? null,
      }
    }),
  }
}

export async function applyReidJerseySuggestion(
  database: PrismaClient,
  input: { suggestionId: string; userId: string; role: UserRole },
) {
  assertEditorRole(input.role)
  const suggestion = await database.reidJerseySuggestion.findUnique({
    where: { id: input.suggestionId },
    include: {
      run: {
        include: {
          analysisRun: {
            select: { submission: { select: { rally: { select: { matchId: true } } } } },
          },
        },
      },
      tracklet: { select: { canonicalTrackId: true } },
    },
  })
  if (!suggestion) throw new Error('NOT_FOUND')
  const matchId = suggestion.run.analysisRun.submission.rally.matchId
  await assertMatchAccess(database, { matchId, userId: input.userId, role: input.role })
  if (suggestion.status !== JobStatus.COMPLETED || !suggestion.suggestedRosterEntryId)
    throw new GraphQLError('這筆背號建議沒有可套用的球員', {
      extensions: { code: 'JERSEY_SUGGESTION_NOT_APPLICABLE' },
    })
  if (suggestion.appliedAt)
    return { suggestion_id: suggestion.id, match_id: matchId, applied: true }
  await assignTrackIdentity(database, {
    analysisRunId: suggestion.run.analysisRunId,
    trackId: suggestion.tracklet.canonicalTrackId,
    rosterEntryId: suggestion.suggestedRosterEntryId,
    identityMode: 'from_here',
    userId: input.userId,
    role: input.role,
  })
  await database.reidJerseySuggestion.update({
    where: { id: suggestion.id },
    data: { appliedAt: new Date(), appliedByUserId: input.userId },
  })
  return { suggestion_id: suggestion.id, match_id: matchId, applied: true }
}
