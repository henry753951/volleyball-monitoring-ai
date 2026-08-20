import type { PrismaClient } from '@volleyball-monitoring/db'
import { JobStatus, UserRole } from '@volleyball-monitoring/db/client'
import { describe, expect, it, vi } from 'vitest'
import {
  getCoachMatchAnalytics,
  observedFrameRangesOverlap,
  providerContactSemantic,
} from '../src/services/coach-analytics.js'

describe('coach identity projections', () => {
  it('reads imported pass, set, and spike semantics with their court side', () => {
    expect(providerContactSemantic({ group_activity_label: 'l_set' })).toEqual({
      phase: 'set',
      courtSide: 'left',
      actionKey: 'set',
    })
    expect(providerContactSemantic({ phase: 'pass', court_side: 'right' })).toEqual({
      phase: 'pass',
      courtSide: 'right',
      actionKey: 'receive',
    })
    expect(providerContactSemantic({ group_activity_label: 'unknown' })).toBeNull()
  })

  it('only treats exact observed frame presence as a local-id conflict', () => {
    expect(
      observedFrameRangesOverlap(
        { __volleyball_system: { observed_frame_ranges_v1: [{ start: '0', end: '10' }] } },
        { __volleyball_system: { observed_frame_ranges_v1: [{ start: '11', end: '20' }] } },
      ),
    ).toBe(false)
    expect(
      observedFrameRangesOverlap(
        { __volleyball_system: { observed_frame_ranges_v1: [{ start: '0', end: '10' }] } },
        { __volleyball_system: { observed_frame_ranges_v1: [{ start: '10', end: '20' }] } },
      ),
    ).toBe(true)
    expect(
      observedFrameRangesOverlap(
        { firstFrame: '0', lastFrame: '100' },
        { firstFrame: '20', lastFrame: '30' },
      ),
    ).toBe(false)
  })

  it('uses the canonical rally outcome for team and set scoring', async () => {
    const findMatch = vi.fn().mockResolvedValue({
      id: 'match-score',
      title: 'Score fixture',
      identityRevision: 0n,
      matchTeams: [
        { team: { id: 'team-left', name: 'Left', shortName: 'L' } },
        { team: { id: 'team-right', name: 'Right', shortName: 'R' } },
      ],
      sets: [
        { id: 'set-1', setNumber: 1, status: 'LIVE', winningTeamId: null, winningRallyId: null },
      ],
      courtSideSwapMarkers: [],
      rosterEntries: [],
      rallies: [
        {
          id: 'rally-1',
          ordinal: 1,
          createdAt: new Date('2026-08-20T00:00:00Z'),
          scoreResolutionState: 'RESOLVED',
          scoringCourtSide: 'RIGHT',
          scoringTeamId: 'team-right',
          set: { setNumber: 1 },
          activeSubmission: {
            id: 'submission-1',
            scoreResolutionState: 'RESOLVED',
            scoringCourtSide: 'LEFT',
            scoringTeamId: 'team-left',
            leftTeamId: 'team-left',
            rightTeamId: 'team-right',
            boundaries: [{ kind: 'START', captureTimeUs: 1_000n }],
            keyPoints: [],
            ballEvents: [],
            clipJobs: [],
            analysisRuns: [],
            analysisSourceRun: null,
          },
        },
      ],
    })
    const database = { match: { findFirst: findMatch } } as unknown as PrismaClient

    const analytics = await getCoachMatchAnalytics(database, {
      matchId: 'match-score',
      userId: 'coach-1',
      role: UserRole.COACH,
    })

    expect(analytics?.sets).toEqual([
      {
        set_number: 1,
        rally_count: 1,
        resolved_count: 1,
        unknown_count: 0,
        team_points: { 'team-left': 0, 'team-right': 1 },
      },
    ])
    expect(analytics?.rallies[0]).toMatchObject({
      score_resolution: 'resolved',
      scoring_team_id: 'team-right',
    })
    expect(analytics?.teams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'team-left', wins: 0 }),
        expect.objectContaining({ id: 'team-right', wins: 1 }),
      ]),
    )
  })

  it('attributes a human ball event through the latest pose-first actor projection', async () => {
    const findMatch = vi.fn().mockResolvedValue({
      id: 'match-1',
      title: 'Fixture',
      identityRevision: 2n,
      matchTeams: [],
      sets: [
        { id: 'set-1', setNumber: 1, status: 'LIVE', winningTeamId: null, winningRallyId: null },
      ],
      courtSideSwapMarkers: [],
      rosterEntries: [
        {
          id: 'roster-7',
          teamId: 'team-left',
          jerseyNumber: '7',
          position: null,
          displayNameSnapshot: 'Seven',
          player: null,
        },
      ],
      rallies: [
        {
          id: 'rally-1',
          ordinal: 1,
          set: { setNumber: 1 },
          activeSubmission: {
            id: 'submission-1',
            scoreResolutionState: 'PENDING',
            scoringTeamId: null,
            leftTeamId: 'team-left',
            rightTeamId: 'team-right',
            boundaries: [{ kind: 'START', captureTimeUs: 1_000n }],
            keyPoints: [],
            ballEvents: [
              {
                ordinal: 1,
                kind: 'SERVE',
                result: 'SUCCESS',
                actorRosterEntryId: null,
                submissionKeyPoint: { id: 'contact-1', captureTimeUs: 1_000n },
              },
            ],
            analysisRuns: [
              {
                id: 'run-1',
                analysisVersion: 'v1',
                identityMappingCompletedAt: null,
                reidEvidenceSets: [
                  {
                    tracklets: [
                      {
                        canonicalTrackId: 7,
                        associationDecisions: [{ confidence: 0.93 }],
                        previews: [],
                        activeProjection: {
                          assignmentRevision: {
                            rosterEntryId: 'roster-7',
                            personClusterId: 'cluster-7',
                            personCluster: { teamId: 'team-left', label: 'Seven' },
                            source: 'MANUAL',
                            revision: 2n,
                          },
                        },
                      },
                    ],
                  },
                ],
                tracks: [
                  {
                    trackId: 7,
                    courtSide: 'LEFT',
                    firstFrame: 0n,
                    lastFrame: 10n,
                    identityAssignments: [],
                  },
                ],
                contactActorCorrections: [],
                contactAssociationJobs: [
                  {
                    keyPointId: 'contact-1',
                    status: JobStatus.COMPLETED,
                    projection: {
                      trackId: 7,
                      confidence: 0.93,
                      observationFrameIndex: 0n,
                    },
                  },
                ],
                contactTimeCorrections: [],
                contactEdits: [],
                actionCorrections: [],
                contactEvents: [
                  {
                    keyPointId: 'contact-1',
                    sequenceIndex: 0,
                    detectionEvidence: { group_activity_label: 'l_set' },
                    anchorFrameIndex: 0n,
                    resolvedFrameIndex: null,
                    associationState: 'AMBIGUOUS',
                    qualityFlags: [],
                    representativePositions: [{ trackId: 7, courtX: 0.25, courtY: 0.75 }],
                    actors: [],
                  },
                ],
                segments: [],
              },
            ],
            analysisSourceRun: null,
          },
        },
      ],
    })
    const database = { match: { findFirst: findMatch } } as unknown as PrismaClient

    const analytics = await getCoachMatchAnalytics(database, {
      matchId: 'match-1',
      userId: 'coach-1',
      role: UserRole.COACH,
    })

    expect(analytics?.players[0]).toMatchObject({
      roster_entry_id: 'roster-7',
      contact_count: 1,
      action_counts: { serve: 1 },
      heatmap_samples: [{ x: 0.25, y: 0.75, action: 'serve' }],
    })
    expect(analytics?.tracks[0]).toMatchObject({
      team_id: 'team-left',
      gid_id: 'cluster-7',
      gid_slot_index: null,
      roster_entry_id: 'roster-7',
      identity_source: 'manual',
    })
    expect(analytics?.action_events[0]).toMatchObject({
      team_id: 'team-left',
      court_side: 'left',
      action_key: 'set',
    })
  })
})
