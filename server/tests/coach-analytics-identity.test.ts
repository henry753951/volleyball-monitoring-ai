import type { PrismaClient } from '@volleyball-monitoring/db'
import { IdentitySource, UserRole } from '@volleyball-monitoring/db/client'
import { describe, expect, it, vi } from 'vitest'
import { assignTrackIdentity } from '../src/services/coach-analytics.js'

describe('coach track identity replacement', () => {
  it('atomically moves an occupied player to the selected track', async () => {
    const tx = {
      analysisTrack: {
        findUnique: vi.fn().mockResolvedValue({
          courtSide: 'LEFT',
          analysisRun: { submission: { leftTeamId: 'team-left', rightTeamId: 'team-right', rally: { matchId: 'match-1' } } },
        }),
      },
      matchRosterEntry: { findUnique: vi.fn().mockResolvedValue({ matchId: 'match-1', teamId: 'team-left' }) },
      matchMember: { findUnique: vi.fn().mockResolvedValue({ userId: 'user-1' }) },
      trackIdentityAssignment: {
        findMany: vi.fn().mockResolvedValue([{ trackId: 4 }]),
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
      where: { analysisRunId: 'run-1', rosterEntryId: 'roster-1', trackId: { not: 9 } },
    })
    expect(tx.trackIdentityAssignment.upsert).toHaveBeenCalledOnce()
  })
})
