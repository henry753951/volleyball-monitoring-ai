import { JobStatus, UserRole } from '@volleyball-monitoring/db/client'
import { describe, expect, it, vi } from 'vitest'
import { requestReidAssociationRerun } from '../src/services/reid-association-rerun.js'

const REQUEST_ID = '10000000-0000-4000-8000-000000000001'
const EXISTING_REQUEST_ID = '10000000-0000-4000-8000-000000000002'
const ANALYSIS_RUN_ID = '20000000-0000-4000-8000-000000000001'
const USER_ID = '30000000-0000-4000-8000-000000000001'
const MATCH_ID = '40000000-0000-4000-8000-000000000001'

const run = {
  submission: {
    rally: { matchId: MATCH_ID, match: { identityRevision: 17n } },
  },
  reidEvidenceSets: [{ id: 'evidence-set' }],
}

const requestRow = {
  id: EXISTING_REQUEST_ID,
  analysisRunId: ANALYSIS_RUN_ID,
  requestedByUserId: USER_ID,
  status: JobStatus.QUEUED,
  reason: null,
  errorMessage: null,
  createdAt: new Date('2026-08-17T00:00:00Z'),
  startedAt: null,
  completedAt: null,
}

describe('requestReidAssociationRerun', () => {
  it('returns the canonical active request even if identity revision advanced while it was queued', async () => {
    const database = {
      analysisRun: { findUnique: vi.fn().mockResolvedValue(run) },
      reidAssociationRerunRequest: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(requestRow),
        create: vi.fn(),
        update: vi.fn(),
      },
    }

    const result = await requestReidAssociationRerun(database as never, {
      requestId: REQUEST_ID,
      analysisRunId: ANALYSIS_RUN_ID,
      userId: USER_ID,
      role: UserRole.OPERATOR,
    })

    expect(result.request_id).toBe(EXISTING_REQUEST_ID)
    expect(database.reidAssociationRerunRequest.create).not.toHaveBeenCalled()
    expect(database.reidAssociationRerunRequest.findFirst).toHaveBeenCalledWith({
      where: {
        analysisRunId: ANALYSIS_RUN_ID,
        status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] },
      },
      orderBy: { createdAt: 'desc' },
    })
  })

  it('persists the requested identity revision for a new rerun', async () => {
    const created = { ...requestRow, id: REQUEST_ID }
    const database = {
      analysisRun: { findUnique: vi.fn().mockResolvedValue(run) },
      reidAssociationRerunRequest: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(created),
        update: vi.fn(),
      },
    }

    const result = await requestReidAssociationRerun(database as never, {
      requestId: REQUEST_ID,
      analysisRunId: ANALYSIS_RUN_ID,
      reason: 'rerun existing evidence',
      userId: USER_ID,
      role: UserRole.COACH,
    })

    expect(result.request_id).toBe(REQUEST_ID)
    expect(database.reidAssociationRerunRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: REQUEST_ID,
        analysisRunId: ANALYSIS_RUN_ID,
        requestedIdentityRevision: 17n,
      }),
    })
  })
})
