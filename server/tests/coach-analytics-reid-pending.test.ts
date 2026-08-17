import { IdentitySource, UserRole } from '@volleyball-monitoring/db/client'
import { describe, expect, it, vi } from 'vitest'
import { assignTrackIdentity } from '../src/services/coach-analytics.js'

describe('manual identity assignment before ReID evidence', () => {
  it('persists a pending manual seed instead of rolling back', async () => {
    const assignment = {
      id: 'assignment-1',
      analysisRunId: 'run-1',
      trackId: 7,
      rosterEntryId: 'roster-1',
      source: IdentitySource.MANUAL,
    }
    const upsert = vi.fn().mockResolvedValue(assignment)
    const tx = {
      analysisTrack: {
        findUnique: vi.fn().mockResolvedValue({
          courtSide: 'LEFT',
          firstFrame: 1n,
          lastFrame: 2n,
          metadata: null,
          analysisRun: {
            submission: {
              leftTeamId: 'team-left',
              rightTeamId: 'team-right',
              rally: { matchId: 'match-1', ordinal: 1, set: { setNumber: 1 } },
            },
          },
        }),
      },
      matchRosterEntry: {
        findUnique: vi.fn().mockResolvedValue({ matchId: 'match-1', teamId: 'team-left' }),
      },
      trackIdentityAssignment: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn(),
        upsert,
        findUniqueOrThrow: vi.fn().mockResolvedValue(assignment),
      },
      $queryRaw: vi.fn(),
    }
    const database = {
      $transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
    }

    const result = await assignTrackIdentity(database as never, {
      analysisRunId: 'run-1',
      trackId: 7,
      rosterEntryId: 'roster-1',
      userId: 'user-1',
      role: UserRole.ADMIN,
    })

    expect(result.evidence_state).toBe('pending')
    expect(result.identity_revision).toBeNull()
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          source: IdentitySource.MANUAL,
          identityRevision: null,
          pendingCorrectionMode: 'from_here',
        }),
      }),
    )
  })
})
