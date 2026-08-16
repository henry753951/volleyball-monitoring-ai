import type { PrismaClient } from '@volleyball-monitoring/db'
import { JobStatus, UserRole } from '@volleyball-monitoring/db/client'
import { describe, expect, it, vi } from 'vitest'
import {
  getCoachMatchAnalytics,
  setTrackIdentityMappingComplete,
} from '../src/services/coach-analytics.js'

describe('coach identity projections', () => {
  it('attributes a human ball event through the latest pose-first actor projection', async () => {
    const findMatch = vi.fn().mockResolvedValue({
      id: 'match-1',
      title: 'Fixture',
      identityRevision: 2n,
      matchTeams: [],
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
      gid_id: 'cluster-7',
      gid_slot_index: null,
      roster_entry_id: 'roster-7',
      identity_source: 'manual',
    })
  })

  it('does not mark mapping complete before versioned evidence exists', async () => {
    const tx = {
      analysisRun: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'run-1',
          status: JobStatus.COMPLETED,
          submission: {
            leftTeamId: 'team-left',
            rightTeamId: 'team-right',
            rally: { matchId: 'match-1' },
          },
        }),
        update: vi.fn(),
      },
      trackIdentityAssignment: { findFirst: vi.fn().mockResolvedValue(null) },
      reidEvidenceSet: { findFirst: vi.fn().mockResolvedValue(null) },
    }
    const database = {
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    } as unknown as PrismaClient

    await expect(
      setTrackIdentityMappingComplete(database, {
        analysisRunId: 'run-1',
        completed: true,
        userId: 'admin-1',
        role: UserRole.ADMIN,
      }),
    ).rejects.toMatchObject({ extensions: { code: 'REID_EVIDENCE_PENDING' } })
    expect(tx.analysisRun.update).not.toHaveBeenCalled()
  })

  it('requires every versioned tracklet to have a roster projection', async () => {
    const tx = {
      analysisRun: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'run-1',
          status: JobStatus.COMPLETED,
          submission: {
            leftTeamId: 'team-left',
            rightTeamId: 'team-right',
            rally: { matchId: 'match-1' },
          },
        }),
        update: vi.fn(),
      },
      trackIdentityAssignment: { findFirst: vi.fn().mockResolvedValue(null) },
      reidEvidenceSet: { findFirst: vi.fn().mockResolvedValue({ id: 'evidence-1' }) },
      reidTracklet: { findFirst: vi.fn().mockResolvedValue({ canonicalTrackId: 12 }) },
    }
    const database = {
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    } as unknown as PrismaClient

    await expect(
      setTrackIdentityMappingComplete(database, {
        analysisRunId: 'run-1',
        completed: true,
        userId: 'admin-1',
        role: UserRole.ADMIN,
      }),
    ).rejects.toMatchObject({
      extensions: { code: 'REID_MANUAL_ASSIGNMENT_REQUIRED', trackId: 12 },
    })
  })
})
