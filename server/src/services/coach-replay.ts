import type { PrismaClient } from '@volleyball-monitoring/db'
import type { Prisma } from '@volleyball-monitoring/db/client'
import { JobStatus, UserRole } from '@volleyball-monitoring/db/client'
import { resolveEffectiveContactFrame } from './effective-contact-frame.js'

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
                  source: true,
                  revision: true,
                  personCluster: { select: { id: true, label: true } },
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
            },
          },
        },
      },
    },
  },
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
  contactAssociationJobs: {
    where: {
      status: { in: [JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.COMPLETED, JobStatus.FAILED] },
    },
    orderBy: [{ reviewRevision: 'desc' as const }, { createdAt: 'desc' as const }],
    select: {
      keyPointId: true,
      frameIndex: true,
      status: true,
      projection: {
        select: {
          trackId: true,
          source: true,
          confidence: true,
          observationFrameIndex: true,
        },
      },
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

const replayBallEventSelect = {
  submissionKeyPointId: true,
  ordinal: true,
  kind: true,
  result: true,
  serveStyle: true,
  semanticSource: true,
  actorRosterEntryId: true,
  actorRosterEntry: {
    select: {
      id: true,
      jerseyNumber: true,
      displayNameSnapshot: true,
      player: { select: { name: true } },
    },
  },
} satisfies Prisma.RallySubmissionBallEventSelect

type ReplayAnalysis = Prisma.AnalysisRunGetPayload<{ select: typeof replayAnalysisSelect }>
type ReplayEvent = ReplayAnalysis['contactEvents'][number]
type ReplayTrack = ReplayAnalysis['tracks'][number]
type ReplayVersionedTracklet = ReplayAnalysis['reidEvidenceSets'][number]['tracklets'][number]
type ReplayBallEvent = Prisma.RallySubmissionBallEventGetPayload<{
  select: typeof replayBallEventSelect
}>

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

export function projectReplayTrack(
  track: ReplayTrack,
  tracklet: ReplayVersionedTracklet | null = null,
) {
  const revision = tracklet?.activeProjection?.assignmentRevision ?? null
  const rosterEntry = revision?.rosterEntry ?? null
  const globalIdentity = revision?.personCluster ?? null
  return {
    track_id: track.trackId,
    court_side: track.courtSide.toLowerCase(),
    first_frame_index: track.firstFrame.toString(),
    last_frame_index: track.lastFrame.toString(),
    mean_confidence: track.meanConfidence,
    global_identity: globalIdentity
      ? {
          id: globalIdentity.id,
          label: globalIdentity.label ?? `GID ${globalIdentity.id.slice(0, 8)}`,
          source: revision?.source.toLowerCase() ?? 'ai',
          confidence: tracklet?.associationDecisions[0]?.confidence ?? null,
          identity_revision: revision?.revision.toString() ?? null,
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

export function projectEffectiveReplayEvents(
  analysis: ReplayAnalysis,
  ballEvents: ReplayBallEvent[] = [],
  submissionFrameByOrdinal: ReadonlyMap<number, bigint> = new Map(),
) {
  const timeByPoint = new Map(
    analysis.contactTimeCorrections.map(correction => [
      correction.keyPointId,
      correction.frameIndex,
    ]),
  )
  const actorByPoint = new Map(
    analysis.contactActorCorrections.map(correction => [correction.keyPointId, correction.trackId]),
  )
  const latestAssociationByPoint = new Map<
    string,
    ReplayAnalysis['contactAssociationJobs'][number]
  >()
  for (const job of analysis.contactAssociationJobs ?? [])
    if (!latestAssociationByPoint.has(job.keyPointId))
      latestAssociationByPoint.set(job.keyPointId, job)
  const contactEdits = analysis.contactEdits ?? []
  const deletedBasePoints = new Set(
    contactEdits
      .filter(edit => edit.deleted && edit.baseKeyPointId)
      .map(edit => edit.baseKeyPointId!),
  )
  const baseEvents = analysis.contactEvents
    .filter(event => !deletedBasePoints.has(event.keyPointId))
    .map(event => {
      const semantic =
        ballEvents.find(
          item =>
            item.submissionKeyPointId === event.sourceKeyPointId ||
            item.submissionKeyPointId === event.keyPointId,
        ) ??
        ballEvents.find(item => item.ordinal === event.sequenceIndex + 1) ??
        null
      const submissionFrame = submissionFrameByOrdinal.get(
        semantic?.ordinal ?? event.sequenceIndex + 1,
      )
      const effectiveFrame = submissionFrame ?? resolveEffectiveContactFrame(event, timeByPoint)
      const correctedTrackId = actorByPoint.get(event.keyPointId)
      const hasActorCorrection = actorByPoint.has(event.keyPointId)
      const associationJob =
        (semantic ? latestAssociationByPoint.get(semantic.submissionKeyPointId) : undefined) ??
        latestAssociationByPoint.get(event.keyPointId)
      const associationProjection =
        associationJob?.status === JobStatus.COMPLETED ? associationJob.projection : null
      const semanticTrackId = semantic?.actorRosterEntryId
        ? (analysis.tracks.find(
            track => track.identityAssignments[0]?.rosterEntry?.id === semantic.actorRosterEntryId,
          )?.trackId ?? null)
        : null
      const effectiveTrackId = semantic?.actorRosterEntryId
        ? semanticTrackId
        : hasActorCorrection
          ? correctedTrackId
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
      const matchedActor =
        effectiveTrackId === null || submissionFrame !== undefined
          ? null
          : event.actors.find(actor => actor.trackId === effectiveTrackId)
      const actors =
        effectiveTrackId === null
          ? []
          : matchedActor
            ? [
                {
                  ...replayActor(matchedActor),
                  observation_frame_index:
                    associationProjection?.observationFrameIndex?.toString() ??
                    matchedActor.observationFrameIndex.toString(),
                  association_confidence:
                    associationProjection?.confidence ?? matchedActor.associationConfidence,
                },
              ]
            : [
                {
                  track_id: effectiveTrackId,
                  observation_frame_index:
                    associationProjection?.observationFrameIndex?.toString() ??
                    effectiveFrame.toString(),
                  association_confidence: associationProjection?.confidence ?? null,
                  frame_bbox: null,
                  frame_foot_pos: null,
                  court_pos: null,
                  action: null,
                },
              ]
      const representativePositions =
        effectiveTrackId === null
          ? event.representativePositions.filter(position => position.trackId === null)
          : event.representativePositions.filter(position => position.trackId === effectiveTrackId)
      return {
        raw: event,
        effectiveFrame,
        wire: {
          // Keep the immutable analysis-event id stable for review commands.
          // Human ball-event semantics are attached separately and must never
          // replace the contact id used by sparse corrections.
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
          association_state: semantic?.actorRosterEntryId
            ? semanticTrackId === null
              ? 'no_player'
              : 'resolved_single'
            : hasActorCorrection
              ? correctedTrackId === null
                ? 'no_player'
                : 'resolved_single'
              : effectiveTrackId === null
                ? event.associationState === 'RESOLVED_SINGLE'
                  ? 'no_player'
                  : event.associationState.toLowerCase()
                : 'resolved_single',
          ball_event: semantic
            ? {
                ordinal: semantic.ordinal,
                kind: semantic.kind.toLowerCase(),
                result: semantic.result?.toLowerCase() ?? null,
                serve_style: semantic.serveStyle?.toLowerCase() ?? null,
                semantic_source: semantic.semanticSource.toLowerCase(),
                actor: semantic.actorRosterEntry
                  ? {
                      roster_entry_id: semantic.actorRosterEntry.id,
                      jersey_number: semantic.actorRosterEntry.jerseyNumber,
                      name:
                        semantic.actorRosterEntry.displayNameSnapshot ??
                        semantic.actorRosterEntry.player?.name ??
                        `#${semantic.actorRosterEntry.jerseyNumber}`,
                      track_id: semanticTrackId,
                    }
                  : null,
              }
            : null,
          ball: {
            state: event.ballState.toLowerCase(),
            frame_index: event.ballFrameIndex?.toString() ?? null,
            frame_pos:
              event.ballFrameX !== null && event.ballFrameY !== null
                ? { x: event.ballFrameX, y: event.ballFrameY }
                : null,
          },
          quality_flags:
            hasActorCorrection ||
            timeByPoint.has(event.keyPointId) ||
            submissionFrame !== undefined ||
            associationProjection
              ? [
                  ...event.qualityFlags,
                  ...(hasActorCorrection || timeByPoint.has(event.keyPointId)
                    ? ['manual_review_effective']
                    : []),
                  ...(associationProjection ? ['contact_association_projection'] : []),
                  ...(submissionFrame !== undefined ? ['submission_timing_projection'] : []),
                ]
              : event.qualityFlags,
          actors,
          candidates:
            hasActorCorrection || associationProjection
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
      const associationJob = latestAssociationByPoint.get(edit.contactId)
      const associationProjection =
        associationJob?.status === JobStatus.COMPLETED ? associationJob.projection : null
      const effectiveTrackId = edit.trackId ?? associationProjection?.trackId ?? null
      const actor =
        effectiveTrackId === null
          ? []
          : [
              {
                track_id: effectiveTrackId,
                observation_frame_index:
                  associationProjection?.observationFrameIndex?.toString() ??
                  edit.frameIndex.toString(),
                association_confidence: associationProjection?.confidence ?? null,
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
          association_state: effectiveTrackId === null ? 'no_player' : 'resolved_single',
          ball_event: null,
          ball: { state: 'missing', frame_index: null, frame_pos: null },
          quality_flags: [
            'manual_review_contact',
            ...(associationProjection ? ['contact_association_projection'] : []),
          ],
          actors: actor,
          candidates: [],
          representative_court_positions: [],
        },
      }
    })
  const ordered = [...baseEvents, ...manualEvents].sort((left, right) =>
    left.effectiveFrame < right.effectiveFrame
      ? -1
      : left.effectiveFrame > right.effectiveFrame
        ? 1
        : left.wire.key_point_id.localeCompare(right.wire.key_point_id),
  )
  return ordered.map((event, sequenceIndex) => ({
    ...event,
    wire: {
      ...event.wire,
      sequence_index: sequenceIndex,
      ball_event: event.wire.ball_event ?? {
        ordinal: sequenceIndex + 1,
        kind: sequenceIndex === 0 ? 'serve' : sequenceIndex === 1 ? 'receive' : 'contact',
        result: sequenceIndex === 0 && ordered.length > 1 ? 'success' : null,
        semantic_source: 'system_default',
        actor: null,
      },
    },
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
          ballEvents: {
            orderBy: { ordinal: 'asc' },
            select: replayBallEventSelect,
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
          analysisSourceRun: { select: replayAnalysisSelect },
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
    : (submission.clipJobs[0] ?? submission.supersedes?.clipJobs[0] ?? null)
  const mappingByPoint = new Map(
    (clip?.keyPointMappings ?? []).map(mapping => [mapping.submissionKeyPointId, mapping]),
  )
  const analysis =
    activeAnalysis ?? submission.analysisSourceRun ?? submission.supersedes?.analysisRuns[0] ?? null
  const sourceProjectionFrames = new Map(
    activeAnalysis
      ? []
      : submission.keyPoints.flatMap(point => {
          const mapping = mappingByPoint.get(point.id)
          return mapping ? [[point.sequenceIndex + 1, mapping.clipFrameIndex] as const] : []
        }),
  )
  const effectiveEvents = analysis
    ? projectEffectiveReplayEvents(analysis, submission.ballEvents, sourceProjectionFrames)
    : []
  const effectiveEventById = new Map(effectiveEvents.map(event => [event.raw.keyPointId, event]))
  return {
    schema_version: '1.3.0',
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
          tracks: analysis.tracks.map(track =>
            projectReplayTrack(
              track,
              analysis.reidEvidenceSets[0]?.tracklets.find(
                tracklet => tracklet.canonicalTrackId === track.trackId,
              ) ?? null,
            ),
          ),
          contact_events: effectiveEvents.map(event => event.wire),
          paths: analysis.segments.map(segment => {
            const startEvent = effectiveEventById.get(segment.startKeyPointId)
            const endEvent = effectiveEventById.get(segment.endKeyPointId)
            const startPositions = startEvent?.wire.representative_court_positions
            const endPositions = endEvent?.wire.representative_court_positions
            return {
              id: segment.id,
              sequence_index: segment.sequenceIndex,
              start_key_point_id: startEvent?.wire.key_point_id ?? segment.startKeyPointId,
              end_key_point_id: endEvent?.wire.key_point_id ?? segment.endKeyPointId,
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
