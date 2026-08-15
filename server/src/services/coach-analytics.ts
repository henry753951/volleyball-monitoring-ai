import type { PrismaClient } from '@volleyball-monitoring/db'
import { JobStatus, UserRole } from '@volleyball-monitoring/db/client'
import { GraphQLError } from 'graphql'
import {
  applyManualReidDecision,
  parseReidIdentityMode,
  ReidIdentityDecisionError,
} from './fixed-roster-reid.js'

const quality = (entries: Iterable<string>) => {
  const counts: Record<string, number> = {}
  for (const entry of entries) counts[entry] = (counts[entry] ?? 0) + 1
  return counts
}
const metric = (
  value: number,
  sampleCount: number,
  excludedCount: number,
  unknownCount: number,
  qualityBreakdown: Record<string, number>,
  featureDependencies: string[],
) => ({
  value,
  sample_count: sampleCount,
  excluded_count: excludedCount,
  unknown_count: unknownCount,
  quality_breakdown: qualityBreakdown,
  feature_dependencies: featureDependencies,
})
const actionName = (value: unknown) =>
  typeof value === 'string'
    ? value
    : value && typeof value === 'object' && 'label' in value && typeof value.label === 'string'
      ? value.label
      : null
const actionCategory = (value: unknown) => {
  const label = actionName(value)?.toLowerCase()
  if (label === 'spiking') return 'attack'
  if (label === 'setting') return 'set'
  if (label === 'digging') return 'defense'
  if (label === 'blocking') return 'block'
  return label ? 'other' : null
}

export async function getCoachMatchAnalytics(
  database: PrismaClient,
  input: { matchId: string; userId: string; role: UserRole },
) {
  const match = await database.match.findFirst({
    where: {
      id: input.matchId,
      ...(input.role === UserRole.ADMIN ? {} : { members: { some: { userId: input.userId } } }),
    },
    select: {
      id: true,
      title: true,
      identityRevision: true,
      matchTeams: { select: { team: { select: { id: true, name: true, shortName: true } } } },
      rosterEntries: {
        where: { active: true },
        orderBy: [{ teamId: 'asc' }, { jerseyNumber: 'asc' }],
        select: {
          id: true,
          teamId: true,
          jerseyNumber: true,
          position: true,
          displayNameSnapshot: true,
          player: { select: { name: true } },
        },
      },
      rallies: {
        where: { activeSubmissionId: { not: null }, voidedAt: null },
        orderBy: [{ set: { setNumber: 'asc' } }, { ordinal: 'asc' }],
        select: {
          id: true,
          ordinal: true,
          set: { select: { setNumber: true } },
          activeSubmission: {
            select: {
              id: true,
              scoreResolutionState: true,
              scoringTeamId: true,
              leftTeamId: true,
              rightTeamId: true,
              analysisRuns: {
                where: { status: JobStatus.COMPLETED },
                orderBy: { activatedAt: 'desc' },
                take: 1,
                select: {
                  id: true,
                  analysisVersion: true,
                  identityMappingCompletedAt: true,
                  tracks: {
                    select: {
                      trackId: true,
                      courtSide: true,
                      firstFrame: true,
                      lastFrame: true,
                      identityAssignments: {
                        select: {
                          rosterEntryId: true,
                          source: true,
                          confidence: true,
                          identityRevision: true,
                          reidIdentity: {
                            select: { id: true, teamId: true, label: true, slotIndex: true },
                          },
                        },
                      },
                      reidObservation: {
                        select: {
                          matchConfidence: true,
                          identityRevision: true,
                          modelNamespace: true,
                          modelName: true,
                          modelCheckpointSha256: true,
                          modelPreprocessVersion: true,
                          modelDimension: true,
                          modelDistance: true,
                          reidIdentity: {
                            select: { id: true, teamId: true, label: true, slotIndex: true },
                          },
                        },
                      },
                    },
                  },
                  contactActorCorrections: { select: { keyPointId: true, trackId: true } },
                  contactTimeCorrections: { select: { keyPointId: true, frameIndex: true } },
                  contactEdits: {
                    select: {
                      contactId: true,
                      baseKeyPointId: true,
                      frameIndex: true,
                      trackId: true,
                      deleted: true,
                    },
                  },
                  actionCorrections: { select: { frameIndex: true, trackId: true, action: true } },
                  contactEvents: {
                    select: {
                      keyPointId: true,
                      anchorFrameIndex: true,
                      resolvedFrameIndex: true,
                      associationState: true,
                      qualityFlags: true,
                      representativePositions: { select: { courtX: true, courtY: true } },
                      actors: {
                        select: { trackId: true, action: true, courtX: true, courtY: true },
                      },
                    },
                  },
                  segments: { select: { renderState: true } },
                },
              },
            },
          },
        },
      },
    },
  })
  if (!match) return null
  const teams = match.matchTeams.map(entry => entry.team)
  const rallies = match.rallies.flatMap(rally =>
    rally.activeSubmission ? [{ ...rally, submission: rally.activeSubmission }] : [],
  )
  const analyzed = rallies.flatMap(rally =>
    rally.submission.analysisRuns[0] ? [{ rally, run: rally.submission.analysisRuns[0] }] : [],
  )
  const events = analyzed.flatMap(entry => {
    const corrections = new Map(
      entry.run.contactActorCorrections.map(correction => [
        correction.keyPointId,
        correction.trackId,
      ]),
    )
    const timeCorrections = new Map(
      (entry.run.contactTimeCorrections ?? []).map(correction => [
        correction.keyPointId,
        correction.frameIndex,
      ]),
    )
    const edits = new Map((entry.run.contactEdits ?? []).map(edit => [edit.contactId, edit]))
    const actionCorrections = new Map(
      (entry.run.actionCorrections ?? []).map(correction => [
        `${correction.frameIndex}:${correction.trackId}`,
        correction.action,
      ]),
    )
    const baseEvents = entry.run.contactEvents
      .filter(event => !edits.get(event.keyPointId)?.deleted)
      .map(event => {
        const correctedTrackId = corrections.get(event.keyPointId)
        const hasCorrection = corrections.has(event.keyPointId)
        const frameIndex =
          timeCorrections.get(event.keyPointId) ??
          event.resolvedFrameIndex ??
          event.anchorFrameIndex
        const selectedActors = !hasCorrection
          ? event.actors
          : correctedTrackId === null
            ? []
            : [
                event.actors.find(actor => actor.trackId === correctedTrackId) ?? {
                  trackId: correctedTrackId,
                  action: null,
                  courtX: null,
                  courtY: null,
                },
              ]
        const actors = selectedActors.map(actor => ({
          ...actor,
          action: actionCorrections.get(`${frameIndex}:${actor.trackId}`) ?? actor.action,
        }))
        return {
          ...event,
          frameIndex,
          actors,
          associationState: hasCorrection
            ? correctedTrackId === null
              ? ('NO_PLAYER' as const)
              : ('RESOLVED_SINGLE' as const)
            : event.associationState,
          runId: entry.run.id,
          rallyId: entry.rally.id,
        }
      })
    const manualEvents = (entry.run.contactEdits ?? [])
      .filter(edit => !edit.baseKeyPointId && !edit.deleted)
      .map(edit => ({
        keyPointId: edit.contactId,
        anchorFrameIndex: edit.frameIndex,
        resolvedFrameIndex: edit.frameIndex,
        frameIndex: edit.frameIndex,
        associationState:
          edit.trackId === null ? ('NO_PLAYER' as const) : ('RESOLVED_SINGLE' as const),
        qualityFlags: ['manual_contact'],
        representativePositions: [] as Array<{ courtX: number; courtY: number }>,
        actors:
          edit.trackId === null
            ? []
            : [
                {
                  trackId: edit.trackId,
                  action: actionCorrections.get(`${edit.frameIndex}:${edit.trackId}`) ?? null,
                  courtX: null,
                  courtY: null,
                },
              ],
        runId: entry.run.id,
        rallyId: entry.rally.id,
      }))
    return [...baseEvents, ...manualEvents].sort((left, right) =>
      Number(left.frameIndex - right.frameIndex),
    )
  })
  const actors = events.flatMap(event =>
    event.actors.map(actor => ({ ...actor, runId: event.runId, rallyId: event.rallyId })),
  )
  const trackAssignments = new Map<string, string>()
  const unassignedTracks: Array<{
    analysis_run_id: string
    track_id: number
    rally_id: string
    set_number: number
    rally_ordinal: number
  }> = []
  for (const entry of analyzed)
    for (const track of entry.run.tracks) {
      const assignment = track.identityAssignments[0]
      if (assignment)
        trackAssignments.set(`${entry.run.id}:${track.trackId}`, assignment.rosterEntryId)
      else
        unassignedTracks.push({
          analysis_run_id: entry.run.id,
          track_id: track.trackId,
          rally_id: entry.rally.id,
          set_number: entry.rally.set.setNumber,
          rally_ordinal: entry.rally.ordinal,
        })
    }
  const playerContacts = new Map<string, number>()
  const playerRallies = new Map<string, Set<string>>()
  const playerActions = new Map<string, Record<string, number>>()
  const playerHeatmaps = new Map<
    string,
    Array<{ x: number; y: number; rally_id: string; set_number: number; action: string | null }>
  >()
  const rosterById = new Map(match.rosterEntries.map(entry => [entry.id, entry]))
  for (const actor of actors) {
    const rosterId = trackAssignments.get(`${actor.runId}:${actor.trackId}`)
    if (rosterId) playerContacts.set(rosterId, (playerContacts.get(rosterId) ?? 0) + 1)
  }
  for (const actor of actors) {
    const rosterId = trackAssignments.get(`${actor.runId}:${actor.trackId}`)
    if (!rosterId) continue
    const entry = analyzed.find(candidate => candidate.run.id === actor.runId)
    if (!entry) continue
    const rallySet = playerRallies.get(rosterId) ?? new Set<string>()
    rallySet.add(actor.rallyId)
    playerRallies.set(rosterId, rallySet)
    const category = actionCategory(actor.action)
    if (category) {
      const counts = playerActions.get(rosterId) ?? {}
      counts[category] = (counts[category] ?? 0) + 1
      playerActions.set(rosterId, counts)
    }
    if (actor.courtX !== null && actor.courtY !== null) {
      const roster = rosterById.get(rosterId)
      const flip = roster?.teamId === entry.rally.submission.rightTeamId
      const samples = playerHeatmaps.get(rosterId) ?? []
      samples.push({
        x: flip ? 1 - actor.courtX : actor.courtX,
        y: flip ? 1 - actor.courtY : actor.courtY,
        rally_id: actor.rallyId,
        set_number: entry.rally.set.setNumber,
        action: category,
      })
      playerHeatmaps.set(rosterId, samples)
    }
  }
  const associationQuality = quality(events.map(event => event.associationState.toLowerCase()))
  const eventQualityFlags = quality(events.flatMap(event => event.qualityFlags))
  const resolvedRallies = rallies.filter(
    rally => rally.submission.scoreResolutionState === 'RESOLVED',
  )
  const unknownRallies = rallies.length - resolvedRallies.length
  const courtSamples = events.reduce(
    (sum, event) =>
      sum +
      event.representativePositions.length +
      event.actors.filter(actor => actor.courtX !== null && actor.courtY !== null).length,
    0,
  )
  const completePaths = analyzed
    .flatMap(entry => entry.run.segments)
    .filter(path => path.renderState === 'COMPLETE').length
  const pathCount = analyzed.reduce((sum, entry) => sum + entry.run.segments.length, 0)
  const actionSamples = actors.filter(actor => actor.action !== null).length
  const assignedTracks = Array.from(trackAssignments).length
  const totalTracks = analyzed.reduce((sum, entry) => sum + entry.run.tracks.length, 0)
  return {
    schema_version: '1.0.0',
    match: { id: match.id, title: match.title },
    identity_revision: match.identityRevision.toString(),
    feature_availability: {
      identity: assignedTracks > 0,
      action: actionSamples > 0,
      court_positions: courtSamples > 0,
    },
    metrics: {
      rally_count: metric(
        rallies.length,
        rallies.length,
        0,
        unknownRallies,
        { resolved: resolvedRallies.length, unknown: unknownRallies },
        ['immutable_submission'],
      ),
      resolved_rally_win_rate: metric(
        resolvedRallies.length ? resolvedRallies.length / rallies.length : 0,
        resolvedRallies.length,
        0,
        unknownRallies,
        { resolved: resolvedRallies.length, unknown: unknownRallies },
        ['immutable_submission', 'resolved_outcome'],
      ),
      contact_event_count: metric(events.length, events.length, 0, 0, associationQuality, [
        'analysis_result',
      ]),
      participant_event_count: metric(
        actors.length,
        actors.length,
        events.filter(event => event.actors.length === 0).length,
        0,
        eventQualityFlags,
        ['analysis_result', 'contact_association'],
      ),
      court_position_samples: metric(
        courtSamples,
        courtSamples,
        events.filter(
          event =>
            event.representativePositions.length === 0 &&
            !event.actors.some(actor => actor.courtX !== null && actor.courtY !== null),
        ).length,
        0,
        eventQualityFlags,
        ['analysis_result', 'court_pos'],
      ),
      complete_path_rate: metric(
        pathCount ? completePaths / pathCount : 0,
        pathCount,
        pathCount - completePaths,
        0,
        quality(
          analyzed.flatMap(entry => entry.run.segments.map(path => path.renderState.toLowerCase())),
        ),
        ['analysis_result', 'court_pos'],
      ),
      identity_coverage: metric(
        totalTracks ? assignedTracks / totalTracks : 0,
        totalTracks,
        totalTracks - assignedTracks,
        0,
        { assigned: assignedTracks, unassigned: totalTracks - assignedTracks },
        ['manual_identity_mapping'],
      ),
      action_samples: metric(actionSamples, actionSamples, actors.length - actionSamples, 0, {}, [
        'provider_action_extension',
      ]),
    },
    teams: teams.map(team => {
      const won = resolvedRallies.filter(rally => rally.submission.scoringTeamId === team.id).length
      return {
        ...team,
        wins: won,
        losses: resolvedRallies.length - won,
        unknown: unknownRallies,
        sample_count: resolvedRallies.length,
      }
    }),
    sets: [...new Set(rallies.map(rally => rally.set.setNumber))].map(setNumber => {
      const items = rallies.filter(rally => rally.set.setNumber === setNumber)
      return {
        set_number: setNumber,
        rally_count: items.length,
        resolved_count: items.filter(rally => rally.submission.scoreResolutionState === 'RESOLVED')
          .length,
        unknown_count: items.filter(rally => rally.submission.scoreResolutionState !== 'RESOLVED')
          .length,
        team_points: Object.fromEntries(
          teams.map(team => [
            team.id,
            items.filter(rally => rally.submission.scoringTeamId === team.id).length,
          ]),
        ),
      }
    }),
    rallies: rallies.map(rally => ({
      id: rally.id,
      set_number: rally.set.setNumber,
      ordinal: rally.ordinal,
      score_resolution: rally.submission.scoreResolutionState.toLowerCase(),
      scoring_team_id: rally.submission.scoringTeamId,
      contact_count: events.filter(event => event.rallyId === rally.id).length,
      replay_url: `/matches/${match.id}/replay/${rally.id}`,
    })),
    players: match.rosterEntries.map(entry => ({
      roster_entry_id: entry.id,
      team_id: entry.teamId,
      jersey_number: entry.jerseyNumber,
      position: entry.position,
      name: entry.displayNameSnapshot ?? entry.player?.name ?? `#${entry.jerseyNumber}`,
      contact_count: playerContacts.get(entry.id) ?? 0,
      sample_count: playerContacts.get(entry.id) ?? 0,
      rally_count: playerRallies.get(entry.id)?.size ?? 0,
      action_counts: playerActions.get(entry.id) ?? {},
      heatmap_samples: playerHeatmaps.get(entry.id) ?? [],
      error_count: null,
    })),
    tracks: analyzed.flatMap(entry =>
      entry.run.tracks.map(track => {
        const assignment = track.identityAssignments[0]
        const observation = track.reidObservation
        const identity = assignment?.reidIdentity ?? observation?.reidIdentity ?? null
        return {
          analysis_run_id: entry.run.id,
          rally_id: entry.rally.id,
          set_number: entry.rally.set.setNumber,
          rally_ordinal: entry.rally.ordinal,
          track_id: track.trackId,
          court_side: track.courtSide.toLowerCase(),
          first_frame_index: track.firstFrame.toString(),
          last_frame_index: track.lastFrame.toString(),
          roster_entry_id: assignment?.rosterEntryId ?? null,
          gid_id: identity?.id ?? null,
          gid_team_id: identity?.teamId ?? null,
          gid_slot_index: identity?.slotIndex ?? null,
          gid_label: identity
            ? `${track.courtSide === 'LEFT' ? 'L' : track.courtSide === 'RIGHT' ? 'R' : 'G'}${identity.slotIndex}`
            : null,
          identity_source: assignment?.source.toLowerCase() ?? (observation ? 'ai' : null),
          identity_confidence: assignment?.confidence ?? observation?.matchConfidence ?? null,
          identity_revision:
            (assignment?.identityRevision ?? observation?.identityRevision)?.toString() ?? null,
          manual_required: Boolean(observation && !assignment),
          reid_model: observation
            ? {
                namespace: observation.modelNamespace,
                name: observation.modelName,
                checkpoint_sha256: observation.modelCheckpointSha256,
                preprocess_version: observation.modelPreprocessVersion,
                dimension: observation.modelDimension,
                distance: observation.modelDistance,
              }
            : null,
          identity_mapping_completed: Boolean(entry.run.identityMappingCompletedAt),
        }
      }),
    ),
    unassigned_tracks: unassignedTracks,
  }
}

export function frameRangesOverlap(
  left: { firstFrame: bigint; lastFrame: bigint },
  right: { firstFrame: bigint; lastFrame: bigint },
) {
  return left.firstFrame <= right.lastFrame && right.firstFrame <= left.lastFrame
}

export async function assignTrackIdentity(
  database: PrismaClient,
  input: {
    analysisRunId: string
    trackId: number
    rosterEntryId: string
    identityMode?: unknown
    userId: string
    role: UserRole
  },
) {
  if (
    input.role !== UserRole.ADMIN &&
    input.role !== UserRole.OPERATOR &&
    input.role !== UserRole.COACH
  )
    throw new Error('FORBIDDEN')
  let identityMode
  try {
    identityMode = parseReidIdentityMode(input.identityMode)
  } catch {
    throw new GraphQLError('身分修正模式無效', { extensions: { code: 'BAD_USER_INPUT' } })
  }
  return database.$transaction(async tx => {
    const track = await tx.analysisTrack.findUnique({
      where: {
        analysisRunId_trackId: { analysisRunId: input.analysisRunId, trackId: input.trackId },
      },
      select: {
        courtSide: true,
        firstFrame: true,
        lastFrame: true,
        analysisRun: {
          select: {
            submission: {
              select: {
                leftTeamId: true,
                rightTeamId: true,
                rally: {
                  select: { matchId: true, ordinal: true, set: { select: { setNumber: true } } },
                },
              },
            },
          },
        },
      },
    })
    const roster = await tx.matchRosterEntry.findUnique({
      where: { id: input.rosterEntryId },
      select: { matchId: true, teamId: true },
    })
    if (!track || !roster || roster.matchId !== track.analysisRun.submission.rally.matchId)
      throw new Error('NOT_FOUND')
    const expectedTeamId =
      track.courtSide === 'LEFT'
        ? track.analysisRun.submission.leftTeamId
        : track.courtSide === 'RIGHT'
          ? track.analysisRun.submission.rightTeamId
          : null
    if (expectedTeamId && roster.teamId !== expectedTeamId) {
      throw new GraphQLError('所選球員不屬於此片段該場側的隊伍', {
        extensions: { code: 'ROSTER_TEAM_MISMATCH' },
      })
    }
    const member =
      input.role === UserRole.ADMIN
        ? true
        : Boolean(
            await tx.matchMember.findUnique({
              where: { matchId_userId: { matchId: roster.matchId, userId: input.userId } },
              select: { userId: true },
            }),
          )
    if (!member) throw new Error('NOT_FOUND')
    await tx.$queryRaw`SELECT id FROM "AnalysisRun" WHERE id = ${input.analysisRunId}::uuid FOR UPDATE`
    const occupied = await tx.trackIdentityAssignment.findMany({
      where: {
        analysisRunId: input.analysisRunId,
        rosterEntryId: input.rosterEntryId,
        trackId: { not: input.trackId },
      },
      select: { trackId: true, track: { select: { firstFrame: true, lastFrame: true } } },
    })
    const replacedTrackIds = occupied
      .filter(item => frameRangesOverlap(track, item.track))
      .map(item => item.trackId)
    if (replacedTrackIds.length)
      await tx.trackIdentityAssignment.deleteMany({
        where: {
          analysisRunId: input.analysisRunId,
          rosterEntryId: input.rosterEntryId,
          trackId: { in: replacedTrackIds },
        },
      })
    let decision
    try {
      decision = await applyManualReidDecision(tx, {
        matchId: roster.matchId,
        teamId: roster.teamId,
        analysisRunId: input.analysisRunId,
        trackId: input.trackId,
        rosterEntryId: input.rosterEntryId,
        userId: input.userId,
        position: {
          setNumber: track.analysisRun.submission.rally.set.setNumber,
          rallyOrdinal: track.analysisRun.submission.rally.ordinal,
        },
        mode: identityMode,
        replacedTrackIds,
      })
    } catch (error) {
      if (error instanceof ReidIdentityDecisionError)
        throw new GraphQLError(error.message, { extensions: { code: error.code } })
      throw error
    }
    const assignment = decision.assignment
    return {
      schema_version: '1.0.0',
      match_id: roster.matchId,
      identity_mode: identityMode,
      identity_revision: decision.identityRevision.toString(),
      gid_id: decision.reidIdentityId,
      replaced_track_ids: replacedTrackIds,
      assignment: {
        id: assignment.id,
        analysis_run_id: assignment.analysisRunId,
        track_id: assignment.trackId,
        roster_entry_id: assignment.rosterEntryId,
        source: assignment.source.toLowerCase(),
      },
    }
  })
}

export async function clearTrackIdentity(
  database: PrismaClient,
  input: { analysisRunId: string; trackId: number; userId: string; role: UserRole },
) {
  if (
    input.role !== UserRole.ADMIN &&
    input.role !== UserRole.OPERATOR &&
    input.role !== UserRole.COACH
  )
    throw new Error('FORBIDDEN')
  return database.$transaction(async tx => {
    const track = await tx.analysisTrack.findUnique({
      where: {
        analysisRunId_trackId: { analysisRunId: input.analysisRunId, trackId: input.trackId },
      },
      select: {
        analysisRun: {
          select: { submission: { select: { rally: { select: { matchId: true } } } } },
        },
      },
    })
    if (!track) throw new Error('NOT_FOUND')
    const member =
      input.role === UserRole.ADMIN
        ? true
        : Boolean(
            await tx.matchMember.findUnique({
              where: {
                matchId_userId: {
                  matchId: track.analysisRun.submission.rally.matchId,
                  userId: input.userId,
                },
              },
              select: { userId: true },
            }),
          )
    if (!member) throw new Error('NOT_FOUND')
    await tx.trackIdentityAssignment.deleteMany({
      where: { analysisRunId: input.analysisRunId, trackId: input.trackId },
    })
    return {
      schema_version: '1.0.0',
      match_id: track.analysisRun.submission.rally.matchId,
      analysis_run_id: input.analysisRunId,
      track_id: input.trackId,
      roster_entry_id: null,
    }
  })
}

export async function setTrackIdentityMappingComplete(
  database: PrismaClient,
  input: { analysisRunId: string; completed: boolean; userId: string; role: UserRole },
) {
  if (
    input.role !== UserRole.ADMIN &&
    input.role !== UserRole.OPERATOR &&
    input.role !== UserRole.COACH
  )
    throw new Error('FORBIDDEN')
  return database.$transaction(async tx => {
    const run = await tx.analysisRun.findUnique({
      where: { id: input.analysisRunId },
      select: {
        id: true,
        status: true,
        submission: {
          select: {
            leftTeamId: true,
            rightTeamId: true,
            rally: { select: { matchId: true } },
          },
        },
      },
    })
    if (!run || run.status !== JobStatus.COMPLETED) throw new Error('NOT_FOUND')
    const matchId = run.submission.rally.matchId
    const member =
      input.role === UserRole.ADMIN
        ? true
        : Boolean(
            await tx.matchMember.findUnique({
              where: { matchId_userId: { matchId, userId: input.userId } },
              select: { userId: true },
            }),
          )
    if (!member) throw new Error('NOT_FOUND')
    if (input.completed) {
      const invalidAssignment = await tx.trackIdentityAssignment.findFirst({
        select: { id: true },
        where: {
          analysisRunId: input.analysisRunId,
          OR: [
            {
              track: { courtSide: 'LEFT' },
              rosterEntry: { teamId: { not: run.submission.leftTeamId } },
            },
            {
              track: { courtSide: 'RIGHT' },
              rosterEntry: { teamId: { not: run.submission.rightTeamId } },
            },
          ],
        },
      })
      if (invalidAssignment) {
        throw new GraphQLError('仍有球員指派不符合此片段的場側隊伍', {
          extensions: { code: 'ROSTER_TEAM_MISMATCH' },
        })
      }
      const unassignedFeature = await tx.reidFeatureObservation.findFirst({
        where: { analysisRunId: input.analysisRunId, track: { identityAssignments: { none: {} } } },
        select: { trackId: true },
      })
      if (unassignedFeature) {
        throw new GraphQLError('仍有辨識到的球員軌跡尚未完成指派', {
          extensions: {
            code: 'REID_MANUAL_ASSIGNMENT_REQUIRED',
            trackId: unassignedFeature.trackId,
          },
        })
      }
    }
    const updated = await tx.analysisRun.update({
      where: { id: input.analysisRunId },
      data: {
        identityMappingCompletedAt: input.completed ? new Date() : null,
        identityMappingCompletedByUserId: input.completed ? input.userId : null,
      },
      select: { id: true, identityMappingCompletedAt: true },
    })
    return {
      schema_version: '1.0.0',
      match_id: matchId,
      analysis_run_id: updated.id,
      completed: Boolean(updated.identityMappingCompletedAt),
    }
  })
}
