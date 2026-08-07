import type { PrismaClient } from '@volleyball-monitoring/db'
import { IdentitySource, JobStatus, UserRole } from '@volleyball-monitoring/db/client'

const quality = (entries: Iterable<string>) => { const counts: Record<string, number> = {}; for (const entry of entries) counts[entry] = (counts[entry] ?? 0) + 1; return counts }
const metric = (value: number, sampleCount: number, excludedCount: number, unknownCount: number, qualityBreakdown: Record<string, number>, featureDependencies: string[]) => ({ value, sample_count: sampleCount, excluded_count: excludedCount, unknown_count: unknownCount, quality_breakdown: qualityBreakdown, feature_dependencies: featureDependencies })

export async function getCoachMatchAnalytics(database: PrismaClient, input: { matchId: string; userId: string; role: UserRole }) {
  const match = await database.match.findFirst({
    where: { id: input.matchId, ...(input.role === UserRole.ADMIN ? {} : { members: { some: { userId: input.userId } } }) },
    select: {
      id: true, title: true,
      matchTeams: { select: { team: { select: { id: true, name: true, shortName: true } } } },
      rosterEntries: { where: { active: true }, orderBy: [{ teamId: 'asc' }, { jerseyNumber: 'asc' }], select: { id: true, teamId: true, jerseyNumber: true, displayNameSnapshot: true, player: { select: { name: true } } } },
      rallies: { where: { activeSubmissionId: { not: null }, voidedAt: null }, select: { id: true, ordinal: true, set: { select: { setNumber: true } }, activeSubmission: { select: { id: true, scoreResolutionState: true, scoringTeamId: true, analysisRuns: { where: { status: JobStatus.COMPLETED }, orderBy: { activatedAt: 'desc' }, take: 1, select: { id: true, analysisVersion: true, identityMappingCompletedAt: true, tracks: { select: { trackId: true, courtSide: true, identityAssignments: { select: { rosterEntryId: true, source: true } } } }, contactEvents: { select: { associationState: true, qualityFlags: true, representativePositions: { select: { courtX: true, courtY: true } }, actors: { select: { trackId: true, action: true, courtX: true, courtY: true } } } }, segments: { select: { renderState: true } } } } } } } },
    },
  })
  if (!match) return null
  const teams = match.matchTeams.map(entry => entry.team)
  const rallies = match.rallies.flatMap(rally => rally.activeSubmission ? [{ ...rally, submission: rally.activeSubmission }] : [])
  const analyzed = rallies.flatMap(rally => rally.submission.analysisRuns[0] ? [{ rally, run: rally.submission.analysisRuns[0] }] : [])
  const events = analyzed.flatMap(entry => entry.run.contactEvents.map(event => ({ ...event, runId: entry.run.id, rallyId: entry.rally.id })))
  const actors = events.flatMap(event => event.actors.map(actor => ({ ...actor, runId: event.runId, rallyId: event.rallyId })))
  const trackAssignments = new Map<string, string>()
  const unassignedTracks: Array<{ analysis_run_id: string; track_id: number; rally_id: string; set_number: number; rally_ordinal: number }> = []
  for (const entry of analyzed) for (const track of entry.run.tracks) { const assignment = track.identityAssignments[0]; if (assignment) trackAssignments.set(`${entry.run.id}:${track.trackId}`, assignment.rosterEntryId); else unassignedTracks.push({ analysis_run_id: entry.run.id, track_id: track.trackId, rally_id: entry.rally.id, set_number: entry.rally.set.setNumber, rally_ordinal: entry.rally.ordinal }) }
  const playerContacts = new Map<string, number>()
  for (const actor of actors) { const rosterId = trackAssignments.get(`${actor.runId}:${actor.trackId}`); if (rosterId) playerContacts.set(rosterId, (playerContacts.get(rosterId) ?? 0) + 1) }
  const associationQuality = quality(events.map(event => event.associationState.toLowerCase()))
  const eventQualityFlags = quality(events.flatMap(event => event.qualityFlags))
  const resolvedRallies = rallies.filter(rally => rally.submission.scoreResolutionState === 'RESOLVED')
  const unknownRallies = rallies.length - resolvedRallies.length
  const courtSamples = events.reduce((sum, event) => sum + event.representativePositions.length + event.actors.filter(actor => actor.courtX !== null && actor.courtY !== null).length, 0)
  const completePaths = analyzed.flatMap(entry => entry.run.segments).filter(path => path.renderState === 'COMPLETE').length
  const pathCount = analyzed.reduce((sum, entry) => sum + entry.run.segments.length, 0)
  const actionSamples = actors.filter(actor => actor.action !== null).length
  const assignedTracks = Array.from(trackAssignments).length
  const totalTracks = analyzed.reduce((sum, entry) => sum + entry.run.tracks.length, 0)
  return {
    schema_version: '1.0.0', match: { id: match.id, title: match.title },
    feature_availability: { identity: assignedTracks > 0, action: actionSamples > 0, court_positions: courtSamples > 0 },
    metrics: {
      rally_count: metric(rallies.length, rallies.length, 0, unknownRallies, { resolved: resolvedRallies.length, unknown: unknownRallies }, ['immutable_submission']),
      resolved_rally_win_rate: metric(resolvedRallies.length ? resolvedRallies.length / rallies.length : 0, resolvedRallies.length, 0, unknownRallies, { resolved: resolvedRallies.length, unknown: unknownRallies }, ['immutable_submission', 'resolved_outcome']),
      contact_event_count: metric(events.length, events.length, 0, 0, associationQuality, ['analysis_result']),
      participant_event_count: metric(actors.length, actors.length, events.filter(event => event.actors.length === 0).length, 0, eventQualityFlags, ['analysis_result', 'contact_association']),
      court_position_samples: metric(courtSamples, courtSamples, events.filter(event => event.representativePositions.length === 0 && !event.actors.some(actor => actor.courtX !== null && actor.courtY !== null)).length, 0, eventQualityFlags, ['analysis_result', 'court_pos']),
      complete_path_rate: metric(pathCount ? completePaths / pathCount : 0, pathCount, pathCount - completePaths, 0, quality(analyzed.flatMap(entry => entry.run.segments.map(path => path.renderState.toLowerCase()))), ['analysis_result', 'court_pos']),
      identity_coverage: metric(totalTracks ? assignedTracks / totalTracks : 0, totalTracks, totalTracks - assignedTracks, 0, { assigned: assignedTracks, unassigned: totalTracks - assignedTracks }, ['manual_identity_mapping']),
      action_samples: metric(actionSamples, actionSamples, actors.length - actionSamples, 0, {}, ['provider_action_extension']),
    },
    teams: teams.map(team => { const won = resolvedRallies.filter(rally => rally.submission.scoringTeamId === team.id).length; return { ...team, wins: won, losses: resolvedRallies.length - won, unknown: unknownRallies, sample_count: resolvedRallies.length } }),
    players: match.rosterEntries.map(entry => ({ roster_entry_id: entry.id, team_id: entry.teamId, jersey_number: entry.jerseyNumber, name: entry.displayNameSnapshot ?? entry.player?.name ?? `#${entry.jerseyNumber}`, contact_count: playerContacts.get(entry.id) ?? 0, sample_count: playerContacts.get(entry.id) ?? 0 })),
    tracks: analyzed.flatMap(entry => entry.run.tracks.map(track => ({
      analysis_run_id: entry.run.id,
      rally_id: entry.rally.id,
      set_number: entry.rally.set.setNumber,
      rally_ordinal: entry.rally.ordinal,
      track_id: track.trackId,
      court_side: track.courtSide.toLowerCase(),
      roster_entry_id: track.identityAssignments[0]?.rosterEntryId ?? null,
      identity_mapping_completed: Boolean(entry.run.identityMappingCompletedAt),
    }))),
    unassigned_tracks: unassignedTracks,
  }
}

export async function assignTrackIdentity(database: PrismaClient, input: { analysisRunId: string; trackId: number; rosterEntryId: string; userId: string; role: UserRole }) {
  if (input.role !== UserRole.ADMIN && input.role !== UserRole.OPERATOR && input.role !== UserRole.COACH) throw new Error('FORBIDDEN')
  return database.$transaction(async (tx) => {
    const track = await tx.analysisTrack.findUnique({ where: { analysisRunId_trackId: { analysisRunId: input.analysisRunId, trackId: input.trackId } }, select: { analysisRun: { select: { submission: { select: { rally: { select: { matchId: true } } } } } } } })
    const roster = await tx.matchRosterEntry.findUnique({ where: { id: input.rosterEntryId }, select: { matchId: true } })
    if (!track || !roster || roster.matchId !== track.analysisRun.submission.rally.matchId) throw new Error('NOT_FOUND')
    const member = input.role === UserRole.ADMIN ? true : Boolean(await tx.matchMember.findUnique({ where: { matchId_userId: { matchId: roster.matchId, userId: input.userId } }, select: { userId: true } }))
    if (!member) throw new Error('NOT_FOUND')
    const assignment = await tx.trackIdentityAssignment.upsert({ where: { analysisRunId_trackId: { analysisRunId: input.analysisRunId, trackId: input.trackId } }, create: { analysisRunId: input.analysisRunId, trackId: input.trackId, rosterEntryId: input.rosterEntryId, source: IdentitySource.MANUAL, assignedByUserId: input.userId }, update: { rosterEntryId: input.rosterEntryId, source: IdentitySource.MANUAL, assignedByUserId: input.userId, confidence: null } })
    return { schema_version: '1.0.0', assignment: { id: assignment.id, analysis_run_id: assignment.analysisRunId, track_id: assignment.trackId, roster_entry_id: assignment.rosterEntryId, source: assignment.source.toLowerCase() } }
  })
}

export async function clearTrackIdentity(database: PrismaClient, input: { analysisRunId: string; trackId: number; userId: string; role: UserRole }) {
  if (input.role !== UserRole.ADMIN && input.role !== UserRole.OPERATOR && input.role !== UserRole.COACH) throw new Error('FORBIDDEN')
  return database.$transaction(async (tx) => {
    const track = await tx.analysisTrack.findUnique({ where: { analysisRunId_trackId: { analysisRunId: input.analysisRunId, trackId: input.trackId } }, select: { analysisRun: { select: { submission: { select: { rally: { select: { matchId: true } } } } } } } })
    if (!track) throw new Error('NOT_FOUND')
    const member = input.role === UserRole.ADMIN ? true : Boolean(await tx.matchMember.findUnique({ where: { matchId_userId: { matchId: track.analysisRun.submission.rally.matchId, userId: input.userId } }, select: { userId: true } }))
    if (!member) throw new Error('NOT_FOUND')
    await tx.trackIdentityAssignment.deleteMany({ where: { analysisRunId: input.analysisRunId, trackId: input.trackId } })
    return { schema_version: '1.0.0', analysis_run_id: input.analysisRunId, track_id: input.trackId, roster_entry_id: null }
  })
}

export async function setTrackIdentityMappingComplete(database: PrismaClient, input: { analysisRunId: string; completed: boolean; userId: string; role: UserRole }) {
  if (input.role !== UserRole.ADMIN && input.role !== UserRole.OPERATOR && input.role !== UserRole.COACH) throw new Error('FORBIDDEN')
  return database.$transaction(async (tx) => {
    const run = await tx.analysisRun.findUnique({ where: { id: input.analysisRunId }, select: { id: true, status: true, submission: { select: { rally: { select: { matchId: true } } } } } })
    if (!run || run.status !== JobStatus.COMPLETED) throw new Error('NOT_FOUND')
    const matchId = run.submission.rally.matchId
    const member = input.role === UserRole.ADMIN ? true : Boolean(await tx.matchMember.findUnique({ where: { matchId_userId: { matchId, userId: input.userId } }, select: { userId: true } }))
    if (!member) throw new Error('NOT_FOUND')
    const updated = await tx.analysisRun.update({ where: { id: input.analysisRunId }, data: { identityMappingCompletedAt: input.completed ? new Date() : null, identityMappingCompletedByUserId: input.completed ? input.userId : null }, select: { id: true, identityMappingCompletedAt: true } })
    return { schema_version: '1.0.0', analysis_run_id: updated.id, completed: Boolean(updated.identityMappingCompletedAt) }
  })
}
