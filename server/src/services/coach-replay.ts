import type { PrismaClient } from '@volleyball-monitoring/db'
import type { Prisma } from '@volleyball-monitoring/db/client'
import { JobStatus, UserRole } from '@volleyball-monitoring/db/client'

const replayClipSelect = {
  id: true,
  actualStartCaptureUs: true,
  actualEndCaptureUs: true,
  keyPointMappings: {
    select: { submissionKeyPointId: true, clipPts: true, clipTimeUs: true, clipFrameIndex: true },
  },
} satisfies Prisma.ClipJobSelect

const replayAnalysisSelect = {
  id: true,
  analysisId: true,
  analysisVersion: true,
  producerName: true,
  producerBuildId: true,
  summary: true,
  reviewRevision: true,
  analysisDataManifest: { select: { fpsNum: true, fpsDen: true } },
  tracks: {
    orderBy: { trackId: 'asc' },
    select: {
      trackId: true,
      courtSide: true,
      firstFrame: true,
      lastFrame: true,
      meanConfidence: true,
      identityAssignments: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          source: true,
          confidence: true,
          identityRevision: true,
          reidIdentity: { select: { id: true, label: true, slotIndex: true } },
          rosterEntry: {
            select: {
              id: true,
              jerseyNumber: true,
              position: true,
              displayNameSnapshot: true,
              player: { select: { name: true } },
            },
          },
        },
      },
      reidObservation: {
        select: {
          matchConfidence: true,
          identityRevision: true,
          reidIdentity: { select: { id: true, label: true, slotIndex: true } },
        },
      },
    },
  },
  contactEvents: {
    orderBy: { sequenceIndex: 'asc' },
    select: {
      keyPointId: true,
      sourceKeyPointId: true,
      anchorOrigin: true,
      detectionConfidence: true,
      detectionEvidence: true,
      sequenceIndex: true,
      markerKind: true,
      isTerminal: true,
      anchorFrameIndex: true,
      resolvedFrameIndex: true,
      anchorTimeUs: true,
      associationState: true,
      ballState: true,
      ballFrameIndex: true,
      ballFrameX: true,
      ballFrameY: true,
      qualityFlags: true,
      actors: {
        select: {
          trackId: true,
          observationFrameIndex: true,
          associationConfidence: true,
          frameX1: true,
          frameY1: true,
          frameX2: true,
          frameY2: true,
          frameFootX: true,
          frameFootY: true,
          courtX: true,
          courtY: true,
          action: true,
        },
      },
      candidates: {
        orderBy: { rank: 'asc' },
        select: { trackId: true, rank: true, confidence: true },
      },
      representativePositions: {
        orderBy: { positionIndex: 'asc' },
        select: { trackId: true, basis: true, courtX: true, courtY: true, confidence: true },
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
  segments: {
    orderBy: { sequenceIndex: 'asc' },
    select: {
      id: true,
      sequenceIndex: true,
      startKeyPointId: true,
      endKeyPointId: true,
      startFrameIndex: true,
      endFrameIndex: true,
      renderState: true,
      isTerminalSegment: true,
      qualityFlags: true,
      positions: {
        orderBy: [{ endpoint: 'asc' }, { positionIndex: 'asc' }],
        select: {
          endpoint: true,
          positionIndex: true,
          trackId: true,
          basis: true,
          courtX: true,
          courtY: true,
          confidence: true,
        },
      },
    },
  },
} satisfies Prisma.AnalysisRunSelect

type ReplayAnalysis = Prisma.AnalysisRunGetPayload<{ select: typeof replayAnalysisSelect }>
type ReplayEvent = ReplayAnalysis['contactEvents'][number]
type ReplayTrack = ReplayAnalysis['tracks'][number]

function replayActor(actor: ReplayEvent['actors'][number]) {
  return {
    track_id: actor.trackId,
    observation_frame_index: actor.observationFrameIndex.toString(),
    association_confidence: actor.associationConfidence,
    frame_bbox:
      actor.frameX1 !== null &&
      actor.frameY1 !== null &&
      actor.frameX2 !== null &&
      actor.frameY2 !== null
        ? { x1: actor.frameX1, y1: actor.frameY1, x2: actor.frameX2, y2: actor.frameY2 }
        : null,
    frame_foot_pos:
      actor.frameFootX !== null && actor.frameFootY !== null
        ? { x: actor.frameFootX, y: actor.frameFootY }
        : null,
    court_pos:
      actor.courtX !== null && actor.courtY !== null ? { x: actor.courtX, y: actor.courtY } : null,
    action: actor.action,
  }
}

export function projectReplayTrack(track: ReplayTrack) {
  const assignment = track.identityAssignments[0] ?? null
  const rosterEntry = assignment?.rosterEntry ?? null
  const globalIdentity = assignment?.reidIdentity ?? track.reidObservation?.reidIdentity ?? null
  return {
    track_id: track.trackId,
    court_side: track.courtSide.toLowerCase(),
    first_frame_index: track.firstFrame.toString(),
    last_frame_index: track.lastFrame.toString(),
    mean_confidence: track.meanConfidence,
    global_identity: globalIdentity
      ? {
          id: globalIdentity.id,
          label: `${track.courtSide === 'LEFT' ? 'L' : track.courtSide === 'RIGHT' ? 'R' : 'G'}${globalIdentity.slotIndex}`,
          source: assignment?.source.toLowerCase() ?? 'ai',
          confidence: assignment?.confidence ?? track.reidObservation?.matchConfidence ?? null,
          identity_revision:
            (assignment?.identityRevision ?? track.reidObservation?.identityRevision)?.toString() ??
            null,
        }
      : null,
    identity: rosterEntry
      ? {
          roster_entry_id: rosterEntry.id,
          jersey_number: rosterEntry.jerseyNumber,
          position: rosterEntry.position,
          name:
            rosterEntry.displayNameSnapshot ??
            rosterEntry.player?.name ??
            `#${rosterEntry.jerseyNumber}`,
        }
      : null,
  }
}

export function projectEffectiveReplayEvents(analysis: ReplayAnalysis) {
  const timeByPoint = new Map(
    analysis.contactTimeCorrections.map(correction => [
      correction.keyPointId,
      correction.frameIndex,
    ]),
  )
  const actorByPoint = new Map(
    analysis.contactActorCorrections.map(correction => [correction.keyPointId, correction.trackId]),
  )
  const contactEdits = analysis.contactEdits ?? []
  const deletedBasePoints = new Set(
    contactEdits
      .filter(edit => edit.deleted && edit.baseKeyPointId)
      .map(edit => edit.baseKeyPointId!),
  )
  const baseEvents = analysis.contactEvents
    .filter(event => !deletedBasePoints.has(event.keyPointId))
    .map(event => {
      const effectiveFrame =
        timeByPoint.get(event.keyPointId) ?? event.resolvedFrameIndex ?? event.anchorFrameIndex
      const correctedTrackId = actorByPoint.get(event.keyPointId)
      const hasActorCorrection = actorByPoint.has(event.keyPointId)
      const actors = !hasActorCorrection
        ? event.actors.map(replayActor)
        : correctedTrackId === null
          ? []
          : [
              event.actors.find(actor => actor.trackId === correctedTrackId)
                ? replayActor(event.actors.find(actor => actor.trackId === correctedTrackId)!)
                : {
                    track_id: correctedTrackId,
                    observation_frame_index: effectiveFrame.toString(),
                    association_confidence: null,
                    frame_bbox: null,
                    frame_foot_pos: null,
                    court_pos: null,
                    action: null,
                  },
            ]
      const representativePositions = !hasActorCorrection
        ? event.representativePositions
        : correctedTrackId === null
          ? []
          : event.representativePositions.filter(position => position.trackId === correctedTrackId)
      return {
        raw: event,
        effectiveFrame,
        wire: {
          key_point_id: event.keyPointId,
          source_key_point_id: event.sourceKeyPointId,
          anchor_origin: event.anchorOrigin,
          detection_confidence: event.detectionConfidence,
          detection_evidence: event.detectionEvidence,
          sequence_index: event.sequenceIndex,
          marker_kind: event.markerKind.toLowerCase(),
          is_terminal: event.isTerminal,
          anchor_frame_index: event.anchorFrameIndex.toString(),
          resolved_frame_index: effectiveFrame.toString(),
          anchor_time_us: event.anchorTimeUs.toString(),
          association_state: hasActorCorrection
            ? correctedTrackId === null
              ? 'no_player'
              : 'resolved_single'
            : event.associationState.toLowerCase(),
          ball: {
            state: event.ballState.toLowerCase(),
            frame_index: event.ballFrameIndex?.toString() ?? null,
            frame_pos:
              event.ballFrameX !== null && event.ballFrameY !== null
                ? { x: event.ballFrameX, y: event.ballFrameY }
                : null,
          },
          quality_flags:
            hasActorCorrection || timeByPoint.has(event.keyPointId)
              ? [...event.qualityFlags, 'manual_review_effective']
              : event.qualityFlags,
          actors,
          candidates: hasActorCorrection
            ? []
            : event.candidates.map(candidate => ({
                track_id: candidate.trackId,
                rank: candidate.rank,
                confidence: candidate.confidence,
              })),
          representative_court_positions: representativePositions.map(position => ({
            track_id: position.trackId,
            basis: position.basis,
            court_pos: { x: position.courtX, y: position.courtY },
            confidence: position.confidence,
          })),
        },
      }
    })
  const fpsNum = BigInt(analysis.analysisDataManifest?.fpsNum ?? 60)
  const fpsDen = BigInt(analysis.analysisDataManifest?.fpsDen ?? 1)
  const manualEvents = contactEdits
    .filter(edit => !edit.baseKeyPointId && !edit.deleted)
    .map(edit => {
      const actor =
        edit.trackId === null
          ? []
          : [
              {
                track_id: edit.trackId,
                observation_frame_index: edit.frameIndex.toString(),
                association_confidence: null,
                frame_bbox: null,
                frame_foot_pos: null,
                court_pos: null,
                action: null,
              },
            ]
      return {
        raw: { keyPointId: edit.contactId },
        effectiveFrame: edit.frameIndex,
        wire: {
          key_point_id: edit.contactId,
          source_key_point_id: null,
          anchor_origin: 'review_manual',
          detection_confidence: null,
          detection_evidence: null,
          sequence_index: 0,
          marker_kind: 'contact',
          is_terminal: false,
          anchor_frame_index: edit.frameIndex.toString(),
          resolved_frame_index: edit.frameIndex.toString(),
          anchor_time_us: ((edit.frameIndex * 1_000_000n * fpsDen) / fpsNum).toString(),
          association_state: edit.trackId === null ? 'no_player' : 'resolved_single',
          ball: { state: 'missing', frame_index: null, frame_pos: null },
          quality_flags: ['manual_review_contact'],
          actors: actor,
          candidates: [],
          representative_court_positions: [],
        },
      }
    })
  return [...baseEvents, ...manualEvents]
    .sort((left, right) =>
      left.effectiveFrame < right.effectiveFrame
        ? -1
        : left.effectiveFrame > right.effectiveFrame
          ? 1
          : left.wire.key_point_id.localeCompare(right.wire.key_point_id),
    )
    .map((event, sequenceIndex) => ({
      ...event,
      wire: { ...event.wire, sequence_index: sequenceIndex },
    }))
}

export async function getCoachRallyReplay(
  database: PrismaClient,
  input: { rallyId: string; userId: string; role: UserRole },
) {
  const rally = await database.rally.findFirst({
    where: {
      id: input.rallyId,
      voidedAt: null,
      activeSubmissionId: { not: null },
      ...(input.role === UserRole.ADMIN
        ? {}
        : { match: { members: { some: { userId: input.userId } } } }),
    },
    select: {
      id: true,
      matchId: true,
      ordinal: true,
      processingStatus: true,
      set: { select: { id: true, setNumber: true } },
      program: { select: { fpsNum: true, fpsDen: true } },
      activeSubmission: {
        select: {
          id: true,
          annotationRevision: true,
          submittedAt: true,
          scoreResolutionState: true,
          scoringCourtSide: true,
          supersedesSubmissionId: true,
          leftTeam: { select: { id: true, name: true, shortName: true } },
          rightTeam: { select: { id: true, name: true, shortName: true } },
          scoringTeam: { select: { id: true, name: true, shortName: true } },
          keyPoints: {
            orderBy: { sequenceIndex: 'asc' },
            select: { id: true, sequenceIndex: true, markerKind: true, isTerminal: true },
          },
          clipJobs: {
            where: { status: JobStatus.COMPLETED, clipAssetId: { not: null } },
            orderBy: { completedAt: 'desc' },
            take: 1,
            select: replayClipSelect,
          },
          analysisRuns: {
            where: { status: JobStatus.COMPLETED },
            orderBy: { activatedAt: 'desc' },
            take: 1,
            select: replayAnalysisSelect,
          },
          supersedes: {
            select: {
              clipJobs: {
                where: { status: JobStatus.COMPLETED, clipAssetId: { not: null } },
                orderBy: { completedAt: 'desc' },
                take: 1,
                select: replayClipSelect,
              },
              analysisRuns: {
                where: { status: JobStatus.COMPLETED },
                orderBy: { activatedAt: 'desc' },
                take: 1,
                select: replayAnalysisSelect,
              },
            },
          },
        },
      },
    },
  })
  const submission = rally?.activeSubmission
  if (!rally || !submission) return null
  const activeAnalysis = submission.analysisRuns[0] ?? null
  const clip = activeAnalysis
    ? (submission.clipJobs[0] ?? null)
    : (submission.supersedes?.clipJobs[0] ?? submission.clipJobs[0] ?? null)
  const mappingByPoint = new Map(
    (clip?.keyPointMappings ?? []).map(mapping => [mapping.submissionKeyPointId, mapping]),
  )
  const analysis = activeAnalysis ?? submission.supersedes?.analysisRuns[0] ?? null
  const effectiveEvents = analysis ? projectEffectiveReplayEvents(analysis) : []
  const effectiveEventById = new Map(effectiveEvents.map(event => [event.raw.keyPointId, event]))
  return {
    schema_version: '1.2.0',
    rally: {
      id: rally.id,
      match_id: rally.matchId,
      ordinal: rally.ordinal,
      processing_status: rally.processingStatus.toLowerCase(),
      set: { id: rally.set.id, number: rally.set.setNumber },
      outcome: {
        score_resolution: submission.scoreResolutionState.toLowerCase(),
        scoring_court_side: submission.scoringCourtSide?.toLowerCase() ?? null,
        scoring_team: submission.scoringTeam,
      },
      left_team: submission.leftTeam,
      right_team: submission.rightTeam,
    },
    submission: {
      id: submission.id,
      annotation_revision: submission.annotationRevision.toString(),
      submitted_at: submission.submittedAt.toISOString(),
      key_points: submission.keyPoints.map(point => {
        const mapping = mappingByPoint.get(point.id)
        return {
          id: point.id,
          sequence_index: point.sequenceIndex,
          marker_kind: point.markerKind.toLowerCase(),
          is_terminal: point.isTerminal,
          clip_pts: mapping?.clipPts.toString() ?? null,
          clip_time_us: mapping?.clipTimeUs.toString() ?? null,
          clip_frame_index: mapping?.clipFrameIndex.toString() ?? null,
        }
      }),
    },
    clip:
      clip && clip.actualStartCaptureUs !== null && clip.actualEndCaptureUs !== null
        ? {
            id: clip.id,
            url: `/api/v1/analysis/rallies/${rally.id}/clip?clipJobId=${clip.id}`,
            duration_us: (clip.actualEndCaptureUs - clip.actualStartCaptureUs).toString(),
            fps: { num: rally.program.fpsNum, den: rally.program.fpsDen },
          }
        : null,
    analysis: analysis
      ? {
          id: analysis.id,
          analysis_id: analysis.analysisId,
          version: analysis.analysisVersion,
          review_revision: analysis.reviewRevision.toString(),
          producer: { name: analysis.producerName, build_id: analysis.producerBuildId },
          summary: analysis.summary,
          tracks: analysis.tracks.map(projectReplayTrack),
          contact_events: effectiveEvents.map(event => event.wire),
          paths: analysis.segments.map(segment => {
            const startEvent = effectiveEventById.get(segment.startKeyPointId)
            const endEvent = effectiveEventById.get(segment.endKeyPointId)
            const startPositions = startEvent?.wire.representative_court_positions
            const endPositions = endEvent?.wire.representative_court_positions
            return {
              id: segment.id,
              sequence_index: segment.sequenceIndex,
              start_key_point_id: segment.startKeyPointId,
              end_key_point_id: segment.endKeyPointId,
              start_frame_index:
                startEvent?.effectiveFrame.toString() ??
                segment.startFrameIndex?.toString() ??
                null,
              end_frame_index:
                endEvent?.effectiveFrame.toString() ?? segment.endFrameIndex?.toString() ?? null,
              render_state: segment.renderState.toLowerCase(),
              is_terminal_segment: segment.isTerminalSegment,
              quality_flags:
                startEvent || endEvent
                  ? [...segment.qualityFlags, 'effective_contact_binding']
                  : segment.qualityFlags,
              start_court_positions: startPositions?.length
                ? startPositions
                : segment.positions
                    .filter(position => position.endpoint === 'START')
                    .map(position => ({
                      track_id: position.trackId,
                      basis: position.basis,
                      court_pos: { x: position.courtX, y: position.courtY },
                      confidence: position.confidence,
                    })),
              end_court_positions: endPositions?.length
                ? endPositions
                : segment.positions
                    .filter(position => position.endpoint === 'END')
                    .map(position => ({
                      track_id: position.trackId,
                      basis: position.basis,
                      court_pos: { x: position.courtX, y: position.courtY },
                      confidence: position.confidence,
                    })),
            }
          }),
        }
      : null,
  }
}
