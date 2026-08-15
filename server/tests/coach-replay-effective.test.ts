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
    const track = projectReplayTrack({
      trackId: 7,
      courtSide: 'LEFT',
      firstFrame: 0n,
      lastFrame: 120n,
      meanConfidence: 0.9,
      identityAssignments: [],
      reidObservation: {
        matchConfidence: 0.95,
        identityRevision: 4n,
        reidIdentity: { id: 'gid-1', label: 'S1', slotIndex: 1 },
      },
    } as never)
    expect(track).toMatchObject({
      track_id: 7,
      global_identity: {
        id: 'gid-1',
        label: 'L1',
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
})
