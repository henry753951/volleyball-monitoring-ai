import type { PrismaClient } from '@volleyball-monitoring/db'
import { IdentitySource, JobStatus, Prisma, UserRole } from '@volleyball-monitoring/db/client'
import { GraphQLError } from 'graphql'
import {
  applyVersionedReidCorrection,
  parseReidCorrectionMode,
  ReidIdentityLedgerError,
  swapVersionedGidRosterBindings,
} from './reid-identity-ledger.js'
import { deriveEffectiveSetNumberMap } from './set-display-projection.js'

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

const SYSTEM_TRACK_METADATA_KEY = '__volleyball_system'
const OBSERVED_FRAME_RANGES_KEY = 'observed_frame_ranges_v1'
type ObservedFrameRange = { start: bigint; end: bigint }

function observedFrameRanges(metadata: unknown): ObservedFrameRange[] | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const system = (metadata as Record<string, unknown>)[SYSTEM_TRACK_METADATA_KEY]
  if (!system || typeof system !== 'object' || Array.isArray(system)) return null
  const raw = (system as Record<string, unknown>)[OBSERVED_FRAME_RANGES_KEY]
  if (!Array.isArray(raw)) return null
  const ranges: ObservedFrameRange[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const start = (item as Record<string, unknown>).start
    const end = (item as Record<string, unknown>).end
    if (
      typeof start !== 'string' ||
      typeof end !== 'string' ||
      !/^\d+$/.test(start) ||
      !/^\d+$/.test(end)
    )
      return null
    const startFrame = BigInt(start)
    const endFrame = BigInt(end)
    if (startFrame > endFrame) return null
    ranges.push({ start: startFrame, end: endFrame })
  }
  return ranges.sort((left, right) =>
    left.start < right.start ? -1 : left.start > right.start ? 1 : 0,
  )
}

export function observedFrameRangesOverlap(leftMetadata: unknown, rightMetadata: unknown) {
  const left = observedFrameRanges(leftMetadata)
  const right = observedFrameRanges(rightMetadata)
  // Missing exact presence is deliberately non-conflicting. A broad
  // first/last interval must never silently unbind another Local ID.
  if (!left || !right) return false
  let rightIndex = 0
  for (const leftRange of left) {
    while (rightIndex < right.length && right[rightIndex]!.end < leftRange.start) rightIndex += 1
    if (rightIndex >= right.length) return false
    if (right[rightIndex]!.start <= leftRange.end) return true
  }
  return false
}

function observedFrameRangesForOutput(metadata: unknown) {
  const ranges = observedFrameRanges(metadata)
  return (
    ranges?.map(range => ({ start: range.start.toString(), end: range.end.toString() })) ?? null
  )
}

const coachAnalysisRunSelect = {
  id: true,
  analysisVersion: true,
  identityMappingCompletedAt: true,
  tracks: {
    select: {
      trackId: true,
      courtSide: true,
      firstFrame: true,
      lastFrame: true,
      metadata: true,
      identityAssignments: {
        take: 1,
        select: {
          rosterEntryId: true,
          source: true,
          confidence: true,
          identityRevision: true,
          pendingCorrectionMode: true,
        },
      },
    },
  },
  reidEvidenceSets: {
    where: { status: 'READY' },
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: {
      tracklets: {
        select: {
          canonicalTrackId: true,
          associationDecisions: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { confidence: true },
          },
          activeProjection: {
            select: {
              assignmentRevision: {
                select: {
                  personClusterId: true,
                  rosterEntryId: true,
                  source: true,
                  revision: true,
                  personCluster: { select: { teamId: true, label: true } },
                },
              },
            },
          },
          previews: {
            where: { status: 'READY' },
            orderBy: { readyAt: 'desc' },
            take: 1,
            select: { id: true },
          },
        },
      },
    },
  },
  contactActorCorrections: { select: { keyPointId: true, trackId: true } },
  contactAssociationJobs: {
    where: {
      status: { in: [JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.COMPLETED, JobStatus.FAILED] },
    },
    orderBy: [{ reviewRevision: 'desc' as const }, { createdAt: 'desc' as const }],
    select: {
      keyPointId: true,
      status: true,
      projection: { select: { trackId: true, confidence: true, observationFrameIndex: true } },
    },
  },
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
      sequenceIndex: true,
      anchorFrameIndex: true,
      resolvedFrameIndex: true,
      anchorTimeUs: true,
      associationState: true,
      qualityFlags: true,
      representativePositions: { select: { trackId: true, courtX: true, courtY: true } },
      actors: {
        select: {
          trackId: true,
          associationConfidence: true,
          action: true,
          courtX: true,
          courtY: true,
        },
      },
    },
  },
  segments: {
    select: {
      renderState: true,
      startKeyPointId: true,
      endKeyPointId: true,
      positions: {
        select: { endpoint: true, trackId: true, courtX: true, courtY: true },
      },
    },
  },
} satisfies Prisma.AnalysisRunSelect

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
      sets: {
        orderBy: { setNumber: 'asc' },
        select: { setNumber: true, status: true, winningTeamId: true },
      },
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
              analysisSourceRunId: true,
              ballEvents: {
                orderBy: { ordinal: 'asc' },
                select: {
                  submissionKeyPointId: true,
                  ordinal: true,
                  kind: true,
                  result: true,
                  actorRosterEntryId: true,
                  submissionKeyPoint: { select: { captureTimeUs: true } },
                },
              },
              clipJobs: {
                where: { status: JobStatus.COMPLETED },
                orderBy: { completedAt: 'desc' },
                take: 1,
                select: {
                  keyPointMappings: {
                    select: { submissionKeyPointId: true, clipFrameIndex: true },
                  },
                },
              },
              analysisRuns: {
                where: { status: JobStatus.COMPLETED },
                orderBy: { activatedAt: 'desc' },
                take: 1,
                select: coachAnalysisRunSelect,
              },
              analysisSourceRun: { select: coachAnalysisRunSelect },
            },
          },
        },
      },
    },
  })
  if (!match) return null
  const effectiveSetNumberByRawSetNumber = deriveEffectiveSetNumberMap(match.sets)
  const effectiveSetNumberFor = (rawSetNumber: number) =>
    effectiveSetNumberByRawSetNumber.get(rawSetNumber) ?? rawSetNumber
  const teams = match.matchTeams.map(entry => entry.team)
  const rallies = match.rallies.flatMap(rally =>
    rally.activeSubmission ? [{ ...rally, submission: rally.activeSubmission }] : [],
  )
  const analyzed = rallies.flatMap(rally => {
    const activeRun = rally.submission.analysisRuns[0] ?? null
    const run = activeRun ?? rally.submission.analysisSourceRun
    return run ? [{ rally, run, usesSourceAnalysis: activeRun === null }] : []
  })
  const events = analyzed.flatMap(entry => {
    const explicitByOrdinal = new Map(
      entry.rally.submission.ballEvents.map(event => [event.ordinal, event]),
    )
    const submissionFrameByPoint = new Map(
      entry.rally.submission.clipJobs?.[0]?.keyPointMappings.map(mapping => [
        mapping.submissionKeyPointId,
        mapping.clipFrameIndex,
      ]) ?? [],
    )
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
    const latestAssociationByPoint = new Map<
      string,
      (typeof entry.run.contactAssociationJobs)[number]
    >()
    for (const job of entry.run.contactAssociationJobs ?? [])
      if (!latestAssociationByPoint.has(job.keyPointId))
        latestAssociationByPoint.set(job.keyPointId, job)
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
        const explicit = explicitByOrdinal.get(event.sequenceIndex + 1)
        const submissionFrame = entry.usesSourceAnalysis
          ? submissionFrameByPoint.get(explicit?.submissionKeyPointId ?? '')
          : undefined
        const correctedTrackId = corrections.get(event.keyPointId)
        const hasCorrection = corrections.has(event.keyPointId)
        const associationJob =
          (explicit ? latestAssociationByPoint.get(explicit.submissionKeyPointId) : undefined) ??
          latestAssociationByPoint.get(event.keyPointId)
        const associationProjection =
          associationJob?.status === JobStatus.COMPLETED ? associationJob.projection : null
        const frameIndex =
          submissionFrame ??
          timeCorrections.get(event.keyPointId) ??
          event.resolvedFrameIndex ??
          event.anchorFrameIndex
        const effectiveTrackId = hasCorrection
          ? (correctedTrackId ?? null)
          : associationProjection
            ? associationProjection.trackId
            : event.associationState === 'RESOLVED_SINGLE'
              ? (event.actors
                  .toSorted(
                    (left, right) =>
                      (right.associationConfidence ?? -1) - (left.associationConfidence ?? -1),
                  )
                  .at(0)?.trackId ?? null)
              : null
        const selectedActors =
          effectiveTrackId === null
            ? []
            : [
                (submissionFrame === undefined
                  ? event.actors.find(actor => actor.trackId === effectiveTrackId)
                  : undefined) ?? {
                  trackId: effectiveTrackId,
                  associationConfidence: associationProjection?.confidence ?? null,
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
          representativePositions:
            submissionFrame !== undefined
              ? []
              : effectiveTrackId === null
                ? event.representativePositions.filter(position => position.trackId === null)
                : event.representativePositions.filter(
                    position => position.trackId === effectiveTrackId,
                  ),
          associationState:
            hasCorrection || associationProjection
              ? effectiveTrackId === null
                ? ('NO_PLAYER' as const)
                : ('RESOLVED_SINGLE' as const)
              : effectiveTrackId === null
                ? event.associationState === 'RESOLVED_SINGLE'
                  ? ('NO_PLAYER' as const)
                  : event.associationState
                : ('RESOLVED_SINGLE' as const),
          qualityFlags: [
            ...event.qualityFlags,
            ...(associationProjection ? ['contact_association_projection'] : []),
            ...(submissionFrame !== undefined ? ['submission_timing_projection'] : []),
          ],
          runId: entry.run.id,
          rallyId: entry.rally.id,
        }
      })
    const manualEvents = (entry.run.contactEdits ?? [])
      .filter(edit => !edit.baseKeyPointId && !edit.deleted)
      .map(edit => {
        const associationJob = latestAssociationByPoint.get(edit.contactId)
        const associationProjection =
          associationJob?.status === JobStatus.COMPLETED ? associationJob.projection : null
        const effectiveTrackId = edit.trackId ?? associationProjection?.trackId ?? null
        return {
          keyPointId: edit.contactId,
          sequenceIndex: null,
          anchorFrameIndex: edit.frameIndex,
          resolvedFrameIndex: edit.frameIndex,
          frameIndex: edit.frameIndex,
          associationState:
            effectiveTrackId === null ? ('NO_PLAYER' as const) : ('RESOLVED_SINGLE' as const),
          qualityFlags: [
            'manual_contact',
            ...(associationProjection ? ['contact_association_projection'] : []),
          ],
          representativePositions: [] as Array<{
            trackId: number | null
            courtX: number
            courtY: number
          }>,
          actors:
            effectiveTrackId === null
              ? []
              : [
                  {
                    trackId: effectiveTrackId,
                    associationConfidence: associationProjection?.confidence ?? null,
                    action: actionCorrections.get(`${edit.frameIndex}:${effectiveTrackId}`) ?? null,
                    courtX: null,
                    courtY: null,
                  },
                ],
          runId: entry.run.id,
          rallyId: entry.rally.id,
        }
      })
    return [...baseEvents, ...manualEvents].sort((left, right) =>
      Number(left.frameIndex - right.frameIndex),
    )
  })
  const humanBallEvents = rallies.flatMap(rally => {
    const effectiveEvents = events.filter(event => event.rallyId === rally.id)
    if (!effectiveEvents.length)
      return (rally.submission.ballEvents ?? []).map(event => ({
        ...event,
        rallyId: rally.id,
        setNumber: effectiveSetNumberFor(rally.set.setNumber),
        submission: rally.submission,
      }))
    return effectiveEvents.map((sourceEvent, index) => {
      const explicit = rally.submission.ballEvents.find(event => event.ordinal === index + 1)
      return {
        ordinal: index + 1,
        kind:
          explicit?.kind ??
          (index === 0
            ? ('SERVE' as const)
            : index === 1
              ? ('RECEIVE' as const)
              : ('CONTACT' as const)),
        result:
          explicit?.result ??
          (index === 0 && effectiveEvents.length > 1 ? ('SUCCESS' as const) : null),
        actorRosterEntryId: explicit?.actorRosterEntryId ?? null,
        submissionKeyPointId: explicit?.submissionKeyPointId ?? null,
        submissionKeyPoint: explicit?.submissionKeyPoint ?? {
          captureTimeUs: sourceEvent.frameIndex,
        },
        rallyId: rally.id,
        setNumber: effectiveSetNumberFor(rally.set.setNumber),
        submission: rally.submission,
      }
    })
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
      const tracklet = entry.run.reidEvidenceSets[0]?.tracklets.find(
        candidate => candidate.canonicalTrackId === track.trackId,
      )
      const rosterEntryId =
        tracklet?.activeProjection?.assignmentRevision.rosterEntryId ??
        track.identityAssignments[0]?.rosterEntryId ??
        null
      if (rosterEntryId) trackAssignments.set(`${entry.run.id}:${track.trackId}`, rosterEntryId)
      else
        unassignedTracks.push({
          analysis_run_id: entry.run.id,
          track_id: track.trackId,
          rally_id: entry.rally.id,
          set_number: effectiveSetNumberFor(entry.rally.set.setNumber),
          rally_ordinal: entry.rally.ordinal,
        })
    }
  const rallyById = new Map(rallies.map(rally => [rally.id, rally]))
  const pathPosition = (
    positions: Array<{ trackId: number | null; courtX: number; courtY: number }>,
    trackId: number | null,
  ) =>
    positions.find(position => position.trackId === trackId) ??
    positions.find(position => position.trackId === null) ??
    positions[0] ??
    null
  const actionEvents = humanBallEvents.map(event => {
    const rally = rallyById.get(event.rallyId)
    const analysis = analyzed.find(candidate => candidate.rally.id === event.rallyId)
    const sourceEvent = events.find(
      candidate =>
        candidate.rallyId === event.rallyId && candidate.sequenceIndex === event.ordinal - 1,
    )
    const inferredTrackId = sourceEvent?.actors[0]?.trackId ?? null
    const rosterEntryId =
      event.actorRosterEntryId ??
      (analysis && inferredTrackId !== null
        ? (trackAssignments.get(`${analysis.run.id}:${inferredTrackId}`) ?? null)
        : null)
    const trackId = sourceEvent?.actors[0]?.trackId ?? null
    const submissionKeyPointId = event.submissionKeyPointId ?? null
    const path = analysis?.run.segments.find(segment =>
      [sourceEvent?.keyPointId, submissionKeyPointId].includes(segment.startKeyPointId),
    )
    const startPosition = path
      ? pathPosition(
          path.positions.filter(position => position.endpoint === 'START'),
          trackId,
        )
      : null
    const endPosition = path
      ? pathPosition(
          path.positions.filter(position => position.endpoint === 'END'),
          trackId,
        )
      : null
    const actionKey = event.kind.toLowerCase() === 'contact' ? 'hit' : event.kind.toLowerCase()
    const sourceAnchorTimeUs =
      sourceEvent && 'anchorTimeUs' in sourceEvent ? sourceEvent.anchorTimeUs : null
    return {
      id: `ball:${event.rallyId}:${event.ordinal}`,
      rally_id: event.rallyId,
      set_number: effectiveSetNumberFor(event.setNumber),
      rally_ordinal: rally?.ordinal ?? 0,
      analysis_run_id: analysis?.run.id ?? null,
      track_id: trackId,
      roster_entry_id: rosterEntryId,
      anchor_time_us:
        sourceAnchorTimeUs?.toString() ?? event.submissionKeyPoint.captureTimeUs.toString(),
      action_key: actionKey,
      action_label: actionKey === 'hit' ? 'HIT' : actionKey.toUpperCase(),
      action_confidence: sourceEvent?.actors[0]?.associationConfidence ?? null,
      result_key: event.result?.toLowerCase() ?? null,
      route_start: startPosition ? { x: startPosition.courtX, y: startPosition.courtY } : null,
      route_end: endPosition ? { x: endPosition.courtX, y: endPosition.courtY } : null,
      court_side:
        analysis && trackId !== null
          ? (analysis.run.tracks
              .find(track => track.trackId === trackId)
              ?.courtSide.toLowerCase() ?? null)
          : null,
      outcome: event.result === 'SUCCESS' ? 'won' : event.result === 'FAILURE' ? 'lost' : 'unknown',
    }
  })
  const playerContacts = new Map<string, number>()
  const playerRallies = new Map<string, Set<string>>()
  const playerActions = new Map<string, Record<string, number>>()
  const playerHeatmaps = new Map<
    string,
    Array<{ x: number; y: number; rally_id: string; set_number: number; action: string | null }>
  >()
  const rosterById = new Map(match.rosterEntries.map(entry => [entry.id, entry]))
  for (const event of humanBallEvents) {
    const analysis = analyzed.find(candidate => candidate.rally.id === event.rallyId)
    const sourceEvent = events.find(
      candidate =>
        candidate.rallyId === event.rallyId && candidate.sequenceIndex === event.ordinal - 1,
    )
    const inferredTrackId = sourceEvent?.actors[0]?.trackId ?? null
    const rosterId =
      event.actorRosterEntryId ??
      (analysis && inferredTrackId !== null
        ? (trackAssignments.get(`${analysis.run.id}:${inferredTrackId}`) ?? null)
        : null)
    if (!rosterId) continue
    playerContacts.set(rosterId, (playerContacts.get(rosterId) ?? 0) + 1)
    const rallySet = playerRallies.get(rosterId) ?? new Set<string>()
    rallySet.add(event.rallyId)
    playerRallies.set(rosterId, rallySet)
    const counts = playerActions.get(rosterId) ?? {}
    const category = event.kind.toLowerCase()
    counts[category] = (counts[category] ?? 0) + 1
    playerActions.set(rosterId, counts)
    const actorPosition = sourceEvent?.actors[0]
    const position =
      actorPosition?.courtX != null && actorPosition?.courtY != null
        ? { courtX: actorPosition.courtX, courtY: actorPosition.courtY }
        : sourceEvent?.representativePositions[0]
    if (position) {
      const roster = rosterById.get(rosterId)
      const flip = roster?.teamId === event.submission.rightTeamId
      const samples = playerHeatmaps.get(rosterId) ?? []
      samples.push({
        x: flip ? 1 - position.courtX : position.courtX,
        y: flip ? 1 - position.courtY : position.courtY,
        rally_id: event.rallyId,
        set_number: effectiveSetNumberFor(event.setNumber),
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
  const humanBallEventSamples = humanBallEvents.length
  const assignedTracks = Array.from(trackAssignments).length
  const totalTracks = analyzed.reduce((sum, entry) => sum + entry.run.tracks.length, 0)
  return {
    schema_version: '1.1.0',
    match: { id: match.id, title: match.title },
    identity_revision: match.identityRevision.toString(),
    feature_availability: {
      identity: assignedTracks > 0,
      action: actionSamples > 0,
      ball_events: humanBallEventSamples > 0,
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
      contact_event_count: metric(
        humanBallEventSamples || events.length,
        humanBallEventSamples || events.length,
        0,
        0,
        humanBallEventSamples
          ? quality(humanBallEvents.map(event => event.kind.toLowerCase()))
          : associationQuality,
        [humanBallEventSamples ? 'human_ball_event' : 'analysis_result'],
      ),
      human_ball_event_samples: metric(
        humanBallEventSamples,
        humanBallEventSamples,
        0,
        0,
        quality(humanBallEvents.map(event => event.kind.toLowerCase())),
        ['human_ball_event'],
      ),
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
    sets: [...new Set(rallies.map(rally => effectiveSetNumberFor(rally.set.setNumber)))].map(
      setNumber => {
        const items = rallies.filter(
          rally => effectiveSetNumberFor(rally.set.setNumber) === setNumber,
        )
        return {
          set_number: setNumber,
          rally_count: items.length,
          resolved_count: items.filter(
            rally => rally.submission.scoreResolutionState === 'RESOLVED',
          ).length,
          unknown_count: items.filter(rally => rally.submission.scoreResolutionState !== 'RESOLVED')
            .length,
          team_points: Object.fromEntries(
            teams.map(team => [
              team.id,
              items.filter(rally => rally.submission.scoringTeamId === team.id).length,
            ]),
          ),
        }
      },
    ),
    rallies: rallies.map(rally => ({
      id: rally.id,
      set_number: effectiveSetNumberFor(rally.set.setNumber),
      ordinal: rally.ordinal,
      score_resolution: rally.submission.scoreResolutionState.toLowerCase(),
      scoring_team_id: rally.submission.scoringTeamId,
      contact_count:
        humanBallEvents.filter(event => event.rallyId === rally.id).length ||
        events.filter(event => event.rallyId === rally.id).length,
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
        const versionedTracklet = entry.run.reidEvidenceSets?.[0]?.tracklets.find(
          candidate => candidate.canonicalTrackId === track.trackId,
        )
        const versioned = versionedTracklet?.activeProjection?.assignmentRevision
        const materialized = track.identityAssignments[0]
        const effectiveRosterEntryId =
          versioned?.rosterEntryId ?? materialized?.rosterEntryId ?? null
        return {
          analysis_run_id: entry.run.id,
          rally_id: entry.rally.id,
          set_number: effectiveSetNumberFor(entry.rally.set.setNumber),
          rally_ordinal: entry.rally.ordinal,
          track_id: track.trackId,
          court_side: track.courtSide.toLowerCase(),
          first_frame_index: track.firstFrame.toString(),
          last_frame_index: track.lastFrame.toString(),
          observed_frame_ranges: observedFrameRangesForOutput(track.metadata),
          roster_entry_id: effectiveRosterEntryId,
          gid_id: versioned?.personClusterId ?? null,
          gid_team_id: versioned?.personCluster?.teamId ?? null,
          gid_slot_index: null,
          gid_label: versioned?.personClusterId
            ? (versioned.personCluster?.label ?? `GID ${versioned.personClusterId.slice(0, 8)}`)
            : null,
          identity_source:
            versioned?.source.toLowerCase() ?? materialized?.source.toLowerCase() ?? null,
          identity_confidence:
            versionedTracklet?.associationDecisions[0]?.confidence ??
            materialized?.confidence ??
            null,
          identity_revision:
            versioned?.revision.toString() ?? materialized?.identityRevision?.toString() ?? null,
          identity_evidence_state: versioned
            ? 'ready'
            : materialized?.pendingCorrectionMode
              ? 'pending'
              : 'unavailable',
          manual_required: !effectiveRosterEntryId,
          identity_preview_url: versionedTracklet?.previews[0]
            ? `/api/v1/reid/previews/${versionedTracklet.previews[0].id}`
            : null,
          reid_model: null,
          identity_mapping_completed: Boolean(entry.run.identityMappingCompletedAt),
        }
      }),
    ),
    unassigned_tracks: unassignedTracks,
    action_events: actionEvents,
  }
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
    identityMode = parseReidCorrectionMode(input.identityMode)
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
        metadata: true,
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
      select: {
        trackId: true,
        track: { select: { firstFrame: true, lastFrame: true, metadata: true } },
      },
    })
    const conflictingTrackIds = occupied
      .filter(item => observedFrameRangesOverlap(track.metadata, item.track.metadata))
      .map(item => item.trackId)
    if (identityMode === 'from_here' && conflictingTrackIds.length)
      throw new GraphQLError(
        '所選球員已在相同 frame 綁定另一個 Local ID，請確認要交換 GID 或只覆寫本片段',
        {
          extensions: {
            code: 'REID_GID_SWAP_CONFIRMATION_REQUIRED',
            conflicting_track_ids: conflictingTrackIds,
          },
        },
      )
    const replacedTrackIds = identityMode === 'clip_only' ? conflictingTrackIds : []
    if (replacedTrackIds.length)
      await tx.trackIdentityAssignment.deleteMany({
        where: {
          analysisRunId: input.analysisRunId,
          rosterEntryId: input.rosterEntryId,
          trackId: { in: replacedTrackIds },
        },
      })
    let decision: Awaited<ReturnType<typeof applyVersionedReidCorrection>> | null = null
    let evidenceState: 'ready' | 'pending' = 'ready'
    try {
      for (const replacedTrackId of replacedTrackIds)
        await applyVersionedReidCorrection(tx, {
          analysisRunId: input.analysisRunId,
          canonicalTrackId: replacedTrackId,
          rosterEntryId: null,
          userId: input.userId,
          mode: 'clip_only',
          reason: `replaced by track ${input.trackId}`,
        })
      decision = await applyVersionedReidCorrection(tx, {
        analysisRunId: input.analysisRunId,
        canonicalTrackId: input.trackId,
        rosterEntryId: input.rosterEntryId,
        userId: input.userId,
        mode: identityMode,
      })
    } catch (error) {
      if (error instanceof ReidIdentityLedgerError && error.code === 'REID_EVIDENCE_PENDING') {
        evidenceState = 'pending'
        await tx.trackIdentityAssignment.upsert({
          where: {
            analysisRunId_trackId: {
              analysisRunId: input.analysisRunId,
              trackId: input.trackId,
            },
          },
          update: {
            rosterEntryId: input.rosterEntryId,
            source: IdentitySource.MANUAL,
            assignedByUserId: input.userId,
            confidence: 1,
            identityRevision: null,
            pendingCorrectionMode: identityMode,
          },
          create: {
            analysisRunId: input.analysisRunId,
            trackId: input.trackId,
            rosterEntryId: input.rosterEntryId,
            source: IdentitySource.MANUAL,
            assignedByUserId: input.userId,
            confidence: 1,
            identityRevision: null,
            pendingCorrectionMode: identityMode,
          },
        })
      } else if (error instanceof ReidIdentityLedgerError)
        throw new GraphQLError(error.message, { extensions: { code: error.code } })
      else throw error
    }
    const assignment = await tx.trackIdentityAssignment.findUniqueOrThrow({
      where: {
        analysisRunId_trackId: {
          analysisRunId: input.analysisRunId,
          trackId: input.trackId,
        },
      },
    })
    return {
      schema_version: '2.0.0',
      match_id: roster.matchId,
      identity_mode: identityMode,
      evidence_state: evidenceState,
      identity_revision: decision?.identityRevision.toString() ?? null,
      gid_id: decision?.targetClusterId ?? null,
      replaced_track_ids: replacedTrackIds,
      conflicting_track_ids: conflictingTrackIds,
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
    let evidenceState: 'ready' | 'pending' = 'ready'
    try {
      await applyVersionedReidCorrection(tx, {
        analysisRunId: input.analysisRunId,
        canonicalTrackId: input.trackId,
        rosterEntryId: null,
        userId: input.userId,
        mode: 'clip_only',
        reason: 'manual identity clear',
      })
    } catch (error) {
      if (error instanceof ReidIdentityLedgerError && error.code === 'REID_EVIDENCE_PENDING') {
        evidenceState = 'pending'
        await tx.trackIdentityAssignment.deleteMany({
          where: { analysisRunId: input.analysisRunId, trackId: input.trackId },
        })
      } else if (error instanceof ReidIdentityLedgerError)
        throw new GraphQLError(error.message, { extensions: { code: error.code } })
      else throw error
    }
    return {
      schema_version: '2.0.0',
      match_id: track.analysisRun.submission.rally.matchId,
      analysis_run_id: input.analysisRunId,
      track_id: input.trackId,
      roster_entry_id: null,
      evidence_state: evidenceState,
    }
  })
}

export async function swapTrackGidRosterBindings(
  database: PrismaClient,
  input: {
    analysisRunId: string
    trackId: number
    targetPersonClusterId: string
    reason?: string | null | undefined
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
  const run = await database.analysisRun.findUnique({
    where: { id: input.analysisRunId },
    select: { submission: { select: { rally: { select: { matchId: true } } } } },
  })
  if (!run) throw new Error('NOT_FOUND')
  if (input.role !== UserRole.ADMIN) {
    const membership = await database.matchMember.findUnique({
      where: {
        matchId_userId: { matchId: run.submission.rally.matchId, userId: input.userId },
      },
      select: { userId: true },
    })
    if (!membership) throw new Error('NOT_FOUND')
  }
  try {
    const result = await database.$transaction(tx =>
      swapVersionedGidRosterBindings(tx, {
        analysisRunId: input.analysisRunId,
        canonicalTrackId: input.trackId,
        targetPersonClusterId: input.targetPersonClusterId,
        userId: input.userId,
        reason: input.reason,
      }),
    )
    return {
      schema_version: '1.0.0',
      match_id: result.matchId,
      correction_id: result.correctionId,
      identity_revision: result.identityRevision.toString(),
      source_gid_id: result.sourceClusterId,
      target_gid_id: result.targetClusterId,
      source_roster_entry_id: result.sourceRosterEntryId,
      target_roster_entry_id: result.targetRosterEntryId,
    }
  } catch (error) {
    if (error instanceof ReidIdentityLedgerError)
      throw new GraphQLError(error.message, { extensions: { code: error.code } })
    throw error
  }
}
