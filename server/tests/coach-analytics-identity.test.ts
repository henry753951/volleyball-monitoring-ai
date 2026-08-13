import type { PrismaClient } from '@volleyball-monitoring/db'
import { IdentitySource, UserRole } from '@volleyball-monitoring/db/client'
import { describe, expect, it, vi } from 'vitest'
import { assignTrackIdentity, getCoachMatchAnalytics, setTrackIdentityMappingComplete } from '../src/services/coach-analytics.js'

describe('coach track identity replacement', () => {
  it('uses the effective corrected contact actor in coach player totals', async () => {
    const database = {
      match: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'match-1', title: 'Fixture', identityRevision: 0n, matchTeams: [],
          rosterEntries: [
            { id: 'roster-1', teamId: 'team-left', jerseyNumber: '1', position: null, displayNameSnapshot: 'One', player: null },
            { id: 'roster-2', teamId: 'team-left', jerseyNumber: '2', position: null, displayNameSnapshot: 'Two', player: null },
          ],
          rallies: [{
            id: 'rally-1', ordinal: 1, set: { setNumber: 1 },
            activeSubmission: {
              id: 'submission-1', scoreResolutionState: 'PENDING', scoringTeamId: null, leftTeamId: 'team-left', rightTeamId: 'team-right',
              analysisRuns: [{
                id: 'run-1', analysisVersion: 'v1', identityMappingCompletedAt: null,
                tracks: [
                  { trackId: 1, courtSide: 'LEFT', firstFrame: 0n, lastFrame: 10n, reidObservation: null, identityAssignments: [{ rosterEntryId: 'roster-1', source: 'MANUAL', confidence: null, identityRevision: null, reidIdentity: null }] },
                  { trackId: 2, courtSide: 'LEFT', firstFrame: 0n, lastFrame: 10n, reidObservation: null, identityAssignments: [{ rosterEntryId: 'roster-2', source: 'MANUAL', confidence: null, identityRevision: null, reidIdentity: null }] },
                ],
                contactActorCorrections: [{ keyPointId: 'contact-1', trackId: 2 }],
                contactTimeCorrections: [], contactEdits: [], actionCorrections: [],
                contactEvents: [{ keyPointId: 'contact-1', anchorFrameIndex: 0n, resolvedFrameIndex: null, associationState: 'RESOLVED_SINGLE', qualityFlags: [], representativePositions: [], actors: [{ trackId: 1, action: null, courtX: null, courtY: null }] }],
                segments: [],
              }],
            },
          }],
        }),
      },
    } as unknown as PrismaClient

    const analytics = await getCoachMatchAnalytics(database, { matchId: 'match-1', userId: 'coach-1', role: UserRole.ADMIN })
    expect(analytics?.players.map(player => [player.roster_entry_id, player.contact_count])).toEqual([
      ['roster-1', 0],
      ['roster-2', 1],
    ])
    expect(analytics?.tracks[0]).toMatchObject({
      identity_source: 'manual', identity_confidence: null, identity_revision: null, reid_model: null,
    })
  })

  it('only moves an occupied player off tracks whose frame ranges overlap', async () => {
    const tx = {
      analysisTrack: {
        findUnique: vi.fn().mockResolvedValue({
          courtSide: 'LEFT',
          firstFrame: 100n,
          lastFrame: 200n,
          analysisRun: { submission: { leftTeamId: 'team-left', rightTeamId: 'team-right', rally: { matchId: 'match-1', ordinal: 3, set: { setNumber: 2 } } } },
        }),
      },
      matchRosterEntry: { findUnique: vi.fn().mockResolvedValue({ matchId: 'match-1', teamId: 'team-left' }) },
      matchMember: { findUnique: vi.fn().mockResolvedValue({ userId: 'user-1' }) },
      match: { update: vi.fn().mockResolvedValue({ identityRevision: 7n }) },
      reidFeatureObservation: { findUnique: vi.fn().mockResolvedValue(null) },
      reidCorrectionEvent: { create: vi.fn().mockResolvedValue({ id: 'correction-1' }) },
      trackIdentityAssignment: {
        findMany: vi.fn().mockResolvedValue([
          { trackId: 4, track: { firstFrame: 150n, lastFrame: 250n } },
          { trackId: 5, track: { firstFrame: 201n, lastFrame: 300n } },
        ]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        upsert: vi.fn().mockResolvedValue({ id: 'assignment-1', analysisRunId: 'run-1', trackId: 9, rosterEntryId: 'roster-1', source: IdentitySource.MANUAL }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'run-1' }]),
    }
    const database = {
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    } as unknown as PrismaClient

    await expect(assignTrackIdentity(database, {
      analysisRunId: 'run-1',
      trackId: 9,
      rosterEntryId: 'roster-1',
      userId: 'user-1',
      role: UserRole.COACH,
    })).resolves.toEqual(expect.objectContaining({
      match_id: 'match-1',
      replaced_track_ids: [4],
      assignment: expect.objectContaining({ track_id: 9, roster_entry_id: 'roster-1' }),
    }))
    expect(tx.trackIdentityAssignment.deleteMany).toHaveBeenCalledWith({
      where: { analysisRunId: 'run-1', rosterEntryId: 'roster-1', trackId: { in: [4] } },
    })
    expect(tx.trackIdentityAssignment.upsert).toHaveBeenCalledOnce()
  })

  it('preserves a same-player track when its frame range does not overlap', async () => {
    const tx = {
      analysisTrack: { findUnique: vi.fn().mockResolvedValue({ courtSide: 'LEFT', firstFrame: 100n, lastFrame: 200n, analysisRun: { submission: { leftTeamId: 'team-left', rightTeamId: 'team-right', rally: { matchId: 'match-1', ordinal: 3, set: { setNumber: 2 } } } } }) },
      matchRosterEntry: { findUnique: vi.fn().mockResolvedValue({ matchId: 'match-1', teamId: 'team-left' }) },
      matchMember: { findUnique: vi.fn().mockResolvedValue({ userId: 'user-1' }) },
      match: { update: vi.fn().mockResolvedValue({ identityRevision: 8n }) },
      reidFeatureObservation: { findUnique: vi.fn().mockResolvedValue(null) },
      reidCorrectionEvent: { create: vi.fn().mockResolvedValue({ id: 'correction-1' }) },
      trackIdentityAssignment: {
        findMany: vi.fn().mockResolvedValue([{ trackId: 5, track: { firstFrame: 201n, lastFrame: 300n } }]),
        deleteMany: vi.fn(),
        upsert: vi.fn().mockResolvedValue({ id: 'assignment-1', analysisRunId: 'run-1', trackId: 9, rosterEntryId: 'roster-1', source: IdentitySource.MANUAL }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'run-1' }]),
    }
    const database = { $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)) } as unknown as PrismaClient

    const result = await assignTrackIdentity(database, { analysisRunId: 'run-1', trackId: 9, rosterEntryId: 'roster-1', userId: 'user-1', role: UserRole.COACH })
    expect(result.replaced_track_ids).toEqual([])
    expect(tx.trackIdentityAssignment.deleteMany).not.toHaveBeenCalled()
  })

  it('blocks mapping completion only when a ReID feature track is unassigned', async () => {
    const tx = {
      analysisRun: {
        findUnique: vi.fn().mockResolvedValue({ id: 'run-1', status: 'COMPLETED', submission: { leftTeamId: 'team-left', rightTeamId: 'team-right', rally: { matchId: 'match-1' } } }),
        update: vi.fn(),
      },
      matchMember: { findUnique: vi.fn().mockResolvedValue({ userId: 'user-1' }) },
      trackIdentityAssignment: { findFirst: vi.fn().mockResolvedValue(null) },
      reidFeatureObservation: { findFirst: vi.fn().mockResolvedValue({ trackId: 12 }) },
    }
    const database = { $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)) } as unknown as PrismaClient

    await expect(setTrackIdentityMappingComplete(database, { analysisRunId: 'run-1', completed: true, userId: 'user-1', role: UserRole.COACH })).rejects.toMatchObject({ extensions: { code: 'REID_MANUAL_ASSIGNMENT_REQUIRED', trackId: 12 } })
    expect(tx.analysisRun.update).not.toHaveBeenCalled()
  })

  it('keeps legacy runs without ReID feature observations completion-compatible', async () => {
    const tx = {
      analysisRun: {
        findUnique: vi.fn().mockResolvedValue({ id: 'run-1', status: 'COMPLETED', submission: { leftTeamId: 'team-left', rightTeamId: 'team-right', rally: { matchId: 'match-1' } } }),
        update: vi.fn().mockResolvedValue({ id: 'run-1', identityMappingCompletedAt: new Date() }),
      },
      matchMember: { findUnique: vi.fn().mockResolvedValue({ userId: 'user-1' }) },
      trackIdentityAssignment: { findFirst: vi.fn().mockResolvedValue(null) },
      reidFeatureObservation: { findFirst: vi.fn().mockResolvedValue(null) },
    }
    const database = { $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)) } as unknown as PrismaClient

    await expect(setTrackIdentityMappingComplete(database, { analysisRunId: 'run-1', completed: true, userId: 'user-1', role: UserRole.COACH })).resolves.toMatchObject({ completed: true })
  })
})
