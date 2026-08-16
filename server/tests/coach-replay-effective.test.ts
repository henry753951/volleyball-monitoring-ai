import type { PrismaClient } from '@volleyball-monitoring/db'
import { JobStatus, UserRole } from '@volleyball-monitoring/db/client'
import { describe, expect, it, vi } from 'vitest'
import {
  getCoachRallyReplay,
  projectEffectiveReplayEvents,
  projectReplayTrack,
} from '../src/services/coach-replay.js'

describe('coach replay effective contact projection', () => {
  it('shows completed analysis to a coach before optional review approval', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'rally-1',
      matchId: 'match-1',
      ordinal: 1,
      processingStatus: 'AI_COMPLETE',
      set: { id: 'set-1', setNumber: 1 },
      program: { fpsNum: 30, fpsDen: 1 },
      activeSubmission: {
        id: 'submission-1',
        annotationRevision: 1n,
        submittedAt: new Date('2026-08-14T00:00:00Z'),
        scoreResolutionState: 'PENDING',
        scoringCourtSide: null,
        supersedesSubmissionId: null,
        leftTeam: { id: 'left', name: 'Left', shortName: 'L' },
        rightTeam: { id: 'right', name: 'Right', shortName: 'R' },
        scoringTeam: null,
        keyPoints: [],
        ballEvents: [],
        clipJobs: [],
        analysisRuns: [
          {
            id: 'analysis-1',
            analysisId: 'provider-analysis-1',
            analysisVersion: '1.0.0',
            producerName: 'fixture',
            producerBuildId: 'fixture-build',
            summary: {},
            reviewRevision: 0n,
            tracks: [],
            contactEvents: [],
            contactActorCorrections: [],
            contactTimeCorrections: [],
            contactEdits: [],
            actionCorrections: [],
            segments: [],
          },
        ],
        analysisSourceRun: null,
        supersedes: null,
      },
    })
    const database = { rally: { findFirst } } as unknown as PrismaClient

    const replay = await getCoachRallyReplay(database, {
      rallyId: 'rally-1',
      userId: 'coach-1',
      role: UserRole.COACH,
    })

    expect(replay?.analysis?.id).toBe('analysis-1')
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          activeSubmission: expect.objectContaining({
            select: expect.objectContaining({
              analysisRuns: expect.objectContaining({ where: { status: JobStatus.COMPLETED } }),
            }),
          }),
        }),
      }),
    )
  })

  it('keeps GID visible even before a roster player is assigned', () => {
    const track = projectReplayTrack(
      {
        trackId: 7,
        courtSide: 'LEFT',
        firstFrame: 0n,
        lastFrame: 120n,
        meanConfidence: 0.9,
        identityAssignments: [],
      } as never,
      {
        canonicalTrackId: 7,
        associationDecisions: [{ confidence: 0.95 }],
        activeProjection: {
          assignmentRevision: {
            source: 'AI',
            revision: 4n,
            personCluster: { id: 'gid-1', label: 'P1' },
            rosterEntry: null,
          },
        },
      } as never,
    )
    expect(track).toMatchObject({
      track_id: 7,
      global_identity: {
        id: 'gid-1',
        label: 'P1',
        source: 'ai',
        confidence: 0.95,
        identity_revision: '4',
      },
      identity: null,
    })
  })

  it('applies time and actor corrections without mutating raw inference', () => {
    const rawActor = {
      trackId: 1,
      observationFrameIndex: 10n,
      associationConfidence: 0.8,
      frameX1: 1,
      frameY1: 2,
      frameX2: 3,
      frameY2: 4,
      frameFootX: 2,
      frameFootY: 4,
      courtX: 0.2,
      courtY: 0.4,
      action: null,
    }
    const analysis = {
      contactTimeCorrections: [{ keyPointId: 'contact-1', frameIndex: 14n }],
      contactActorCorrections: [{ keyPointId: 'contact-1', trackId: 2 }],
      contactEvents: [
        {
          keyPointId: 'contact-1',
          sourceKeyPointId: null,
          anchorOrigin: 'ai_detected',
          detectionConfidence: 0.9,
          detectionEvidence: null,
          sequenceIndex: 0,
          markerKind: 'CONTACT',
          isTerminal: false,
          anchorFrameIndex: 10n,
          resolvedFrameIndex: 11n,
          anchorTimeUs: 1000n,
          associationState: 'RESOLVED_SINGLE',
          ballState: 'OBSERVED',
          ballFrameIndex: 10n,
          ballFrameX: 100,
          ballFrameY: 200,
          qualityFlags: [],
          actors: [rawActor],
          candidates: [],
          representativePositions: [],
        },
      ],
    } as unknown as Parameters<typeof projectEffectiveReplayEvents>[0]

    const [event] = projectEffectiveReplayEvents(analysis)
    expect(event?.wire).toMatchObject({
      resolved_frame_index: '14',
      association_state: 'resolved_single',
      actors: [{ track_id: 2, observation_frame_index: '14', frame_bbox: null }],
      quality_flags: ['manual_review_effective'],
    })
    expect(rawActor.trackId).toBe(1)
  })

  it('projects one effective human actor and human ball-event semantics', () => {
    const analysis = {
      tracks: [
        {
          trackId: 7,
          identityAssignments: [{ rosterEntry: { id: 'roster-11' } }],
        },
      ],
      contactTimeCorrections: [],
      contactActorCorrections: [],
      contactEdits: [],
      analysisDataManifest: { fpsNum: 60, fpsDen: 1 },
      contactEvents: [
        {
          keyPointId: 'source-point',
          sourceKeyPointId: null,
          anchorOrigin: 'human_anchor',
          detectionConfidence: null,
          detectionEvidence: null,
          sequenceIndex: 0,
          markerKind: 'CONTACT',
          isTerminal: false,
          anchorFrameIndex: 10n,
          resolvedFrameIndex: 10n,
          anchorTimeUs: 1000n,
          associationState: 'AMBIGUOUS',
          ballState: 'OBSERVED',
          ballFrameIndex: 10n,
          ballFrameX: 100,
          ballFrameY: 200,
          qualityFlags: [],
          actors: [
            {
              trackId: 3,
              observationFrameIndex: 10n,
              associationConfidence: 0.8,
              frameX1: 1,
              frameY1: 2,
              frameX2: 3,
              frameY2: 4,
              frameFootX: 2,
              frameFootY: 4,
              courtX: 0.2,
              courtY: 0.4,
              action: null,
            },
            {
              trackId: 7,
              observationFrameIndex: 10n,
              associationConfidence: 0.7,
              frameX1: 5,
              frameY1: 6,
              frameX2: 7,
              frameY2: 8,
              frameFootX: 6,
              frameFootY: 8,
              courtX: 0.6,
              courtY: 0.8,
              action: null,
            },
          ],
          candidates: [],
          representativePositions: [],
        },
      ],
    } as unknown as Parameters<typeof projectEffectiveReplayEvents>[0]
    const semantics = [
      {
        submissionKeyPointId: 'corrected-point',
        ordinal: 1,
        kind: 'SERVE',
        result: 'POINT_SCORED',
        semanticSource: 'HUMAN',
        actorRosterEntryId: 'roster-11',
        actorRosterEntry: {
          id: 'roster-11',
          jerseyNumber: '11',
          displayNameSnapshot: '王小明',
          player: null,
        },
      },
    ] as unknown as Parameters<typeof projectEffectiveReplayEvents>[1]

    const [event] = projectEffectiveReplayEvents(analysis, semantics)
    expect(event?.wire).toMatchObject({
      key_point_id: 'corrected-point',
      association_state: 'resolved_single',
      actors: [{ track_id: 7 }],
      ball_event: {
        ordinal: 1,
        kind: 'serve',
        result: 'point_scored',
        actor: { jersey_number: '11', name: '王小明', track_id: 7 },
      },
    })
  })

  it('uses only the latest completed pose-first actor projection for an ambiguous contact', () => {
    const analysis = {
      tracks: [],
      contactTimeCorrections: [],
      contactActorCorrections: [],
      contactAssociationJobs: [
        {
          keyPointId: 'contact-1',
          frameIndex: 14n,
          status: JobStatus.COMPLETED,
          projection: {
            trackId: 7,
            source: 'POSE_HAND',
            confidence: 0.92,
            observationFrameIndex: 14n,
          },
        },
      ],
      contactEdits: [],
      analysisDataManifest: { fpsNum: 60, fpsDen: 1 },
      contactEvents: [
        {
          keyPointId: 'contact-1',
          sourceKeyPointId: null,
          anchorOrigin: 'human_anchor',
          detectionConfidence: null,
          detectionEvidence: null,
          sequenceIndex: 0,
          markerKind: 'CONTACT',
          isTerminal: false,
          anchorFrameIndex: 14n,
          resolvedFrameIndex: 14n,
          anchorTimeUs: 1_000n,
          associationState: 'AMBIGUOUS',
          ballState: 'OBSERVED',
          ballFrameIndex: 14n,
          ballFrameX: 100,
          ballFrameY: 200,
          qualityFlags: [],
          actors: [
            {
              trackId: 3,
              observationFrameIndex: 14n,
              associationConfidence: 0.8,
              frameX1: 1,
              frameY1: 2,
              frameX2: 3,
              frameY2: 4,
              frameFootX: 2,
              frameFootY: 4,
              courtX: 0.2,
              courtY: 0.4,
              action: null,
            },
            {
              trackId: 7,
              observationFrameIndex: 14n,
              associationConfidence: 0.7,
              frameX1: 5,
              frameY1: 6,
              frameX2: 7,
              frameY2: 8,
              frameFootX: 6,
              frameFootY: 8,
              courtX: 0.6,
              courtY: 0.8,
              action: null,
            },
          ],
          candidates: [],
          representativePositions: [
            {
              trackId: 3,
              basis: 'ACTOR_FOOT',
              courtX: 0.2,
              courtY: 0.4,
              confidence: 0.8,
            },
            {
              trackId: 7,
              basis: 'ACTOR_FOOT',
              courtX: 0.6,
              courtY: 0.8,
              confidence: 0.7,
            },
          ],
        },
      ],
    } as unknown as Parameters<typeof projectEffectiveReplayEvents>[0]

    const [event] = projectEffectiveReplayEvents(analysis)

    expect(event?.wire).toMatchObject({
      association_state: 'resolved_single',
      actors: [{ track_id: 7, association_confidence: 0.92 }],
      representative_court_positions: [{ track_id: 7 }],
      quality_flags: ['contact_association_projection'],
    })
  })
})
