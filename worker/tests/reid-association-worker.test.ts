import { JobStatus } from '@volleyball-monitoring/db/client'
import { describe, expect, it } from 'vitest'
import {
  hasReidAssociationRerun,
  hasReidAssociationRevision,
  planReidAssociationDecisions,
  reidAssociationIdempotencyKey,
  ReidAssociationMaterializationError,
} from '../src/roles/reid-association-worker.js'

const TRACKLET_A = '20000000-0000-4000-8000-000000000001'
const TRACKLET_B = '20000000-0000-4000-8000-000000000002'
const PEER_SIDE_TRACKLET = '20000000-0000-4000-8000-000000000003'

it('keeps association idempotency keys within the Provider Work wire limit', () => {
  const key = reidAssociationIdempotencyKey({
    evidenceSetId: 'a'.repeat(128),
    teamId: 'b'.repeat(128),
    bankContentSha256: 'c'.repeat(64),
    rerunRequestId: 'd'.repeat(128),
  })

  expect(key).toHaveLength(81)
  expect(key).toMatch(/^reid-association:[a-f0-9]{64}$/)
})

const decision = (trackletId: string) => ({
  tracklet_id: trackletId,
  group_key: 'left-team',
  action: 'CREATE_NEW_GID',
  confidence: 0,
  association_state: 'UNRESOLVED',
  selected_person_cluster_id: null,
  selected_roster_entry_id: null,
  new_gid_group_key: `left-team:${trackletId}`,
  candidates: [],
  unresolved_reason: 'no sufficient evidence',
})

describe('ReID association materialization boundary', () => {
  it('requires a new immutable run when a correction advances the bank revision', () => {
    const runs = [
      {
        status: JobStatus.COMPLETED,
        bankSnapshot: {
          teamId: 'team-a',
          revision: 7n,
          derivationVersion: 'human-confirmed-seed-v4',
        },
      },
      {
        status: JobStatus.COMPLETED,
        bankSnapshot: {
          teamId: 'team-b',
          revision: 9n,
          derivationVersion: 'human-confirmed-seed-v4',
        },
      },
    ]

    expect(hasReidAssociationRevision(runs, 'team-a', 7n)).toBe(true)
    expect(hasReidAssociationRevision(runs, 'team-a', 8n)).toBe(false)
    expect(hasReidAssociationRevision(runs, 'team-b', 9n)).toBe(true)
  })

  it('deduplicates each team independently for an explicit rerun request', () => {
    const runs = [
      {
        status: JobStatus.COMPLETED,
        rerunRequestId: 'request-1',
        bankSnapshot: {
          teamId: 'team-a',
          revision: 7n,
          derivationVersion: 'human-confirmed-seed-v4',
        },
      },
    ]

    expect(hasReidAssociationRerun(runs, 'team-a', 'request-1')).toBe(true)
    expect(hasReidAssociationRerun(runs, 'team-b', 'request-1')).toBe(false)
    expect(hasReidAssociationRerun(runs, 'team-a', 'request-2')).toBe(false)
  })

  it('accepts one and only one decision for every eligible local-side tracklet', () => {
    const planned = planReidAssociationDecisions(
      { eligible_tracklet_ids: [TRACKLET_A, TRACKLET_B] },
      { decisions: [decision(TRACKLET_B), decision(TRACKLET_A)] },
    )

    expect([...planned.eligible]).toEqual([TRACKLET_A, TRACKLET_B])
    expect(planned.decisions).toHaveLength(2)
  })

  it.each([
    {
      name: 'duplicates one decision and omits another',
      decisions: [decision(TRACKLET_A), decision(TRACKLET_A)],
    },
    {
      name: 'returns a decision for the peer-side tracklet',
      decisions: [decision(TRACKLET_A), decision(PEER_SIDE_TRACKLET)],
    },
  ])('rejects a worker result that $name', ({ decisions }) => {
    expect(() =>
      planReidAssociationDecisions(
        { eligible_tracklet_ids: [TRACKLET_A, TRACKLET_B] },
        { decisions },
      ),
    ).toThrowError(ReidAssociationMaterializationError)
  })
})
