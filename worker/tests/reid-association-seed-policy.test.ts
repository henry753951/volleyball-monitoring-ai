import { JobStatus, ReidEvidenceState } from '@volleyball-monitoring/db/client'
import { describe, expect, it } from 'vitest'
import {
  hasReidAssociationRevision,
  isReidBankSeedMembership,
  maximumSameFrameTeamCount,
  planCappedGidResolutions,
  resolveReidBankRevision,
} from '../src/roles/reid-association-worker.js'

describe('ReID bank seed membership policy', () => {
  it('uses prior and current-rally human confirmations as seeds', () => {
    expect(
      isReidBankSeedMembership({
        evidenceState: ReidEvidenceState.CONFIRMED,
        setNumber: 1,
        rallyOrdinal: 1,
        currentSetNumber: 1,
        currentRallyOrdinal: 2,
      }),
    ).toBe(true)

    expect(
      isReidBankSeedMembership({
        evidenceState: ReidEvidenceState.CONFIRMED,
        setNumber: 1,
        rallyOrdinal: 2,
        currentSetNumber: 1,
        currentRallyOrdinal: 2,
      }),
    ).toBe(true)
  })

  it('uses prior automatic evidence for matching without feeding the current rally into itself', () => {
    expect(
      isReidBankSeedMembership({
        evidenceState: ReidEvidenceState.UNVERIFIED,
        setNumber: 1,
        rallyOrdinal: 2,
        currentSetNumber: 1,
        currentRallyOrdinal: 2,
      }),
    ).toBe(false)

    expect(
      isReidBankSeedMembership({
        evidenceState: ReidEvidenceState.UNVERIFIED,
        setNumber: 1,
        rallyOrdinal: 1,
        currentSetNumber: 1,
        currentRallyOrdinal: 2,
      }),
    ).toBe(true)
  })

  it('ignores bindings for clusters that have no eligible vector seed', () => {
    expect(
      resolveReidBankRevision(
        [{ personClusterId: 'human-seed', sourceRevision: 12n }],
        [
          { personClusterId: 'human-seed', revision: 13n },
          { personClusterId: 'current-auto-output', revision: 99n },
        ],
      ),
    ).toBe(13n)
  })

  it('does not let cancelled work block the corrected bank revision', () => {
    expect(
      hasReidAssociationRevision(
        [
          {
            status: JobStatus.CANCELLED,
            bankSnapshot: {
              teamId: 'team-a',
              revision: 13n,
              derivationVersion: 'active-history-capped-gid-v5',
            },
          },
        ],
        'team-a',
        13n,
      ),
    ).toBe(false)
  })

  it('does not turn sequential fragments into same-frame overflow capacity', () => {
    expect(
      maximumSameFrameTeamCount([
        { id: 'a', firstFrameIndex: 0n, lastFrameIndex: 9n, cannotLinkTrackletIds: [] },
        { id: 'b', firstFrameIndex: 10n, lastFrameIndex: 19n, cannotLinkTrackletIds: [] },
        { id: 'c', firstFrameIndex: 20n, lastFrameIndex: 29n, cannotLinkTrackletIds: [] },
      ]),
    ).toBe(1)
  })

  it('does not treat overlapping ranges as co-visibility without cannot-link evidence', () => {
    expect(
      maximumSameFrameTeamCount([
        { id: 'a', firstFrameIndex: 0n, lastFrameIndex: 20n, cannotLinkTrackletIds: [] },
        { id: 'b', firstFrameIndex: 5n, lastFrameIndex: 15n, cannotLinkTrackletIds: [] },
        { id: 'c', firstFrameIndex: 10n, lastFrameIndex: 12n, cannotLinkTrackletIds: [] },
      ]),
    ).toBe(1)
  })

  it('reuses the six persistent team GIDs when extra fragments are not co-visible', () => {
    const existingGids = Array.from({ length: 6 }, (_, index) => ({
      id: `gid-${index + 1}`,
      rosterEntryId: null,
    }))
    const tracklets = Array.from({ length: 8 }, (_, index) => ({
      id: `tracklet-${index + 1}`,
      firstFrameIndex: BigInt(index * 10),
      lastFrameIndex: BigInt(index * 10 + 9),
      cannotLinkTrackletIds: [],
    }))
    const decisions = tracklets.map((tracklet, index) => ({
      tracklet_id: tracklet.id,
      group_key: `group-${index + 1}`,
      action: 'CREATE_NEW_GID' as const,
      selected_person_cluster_id: null,
      selected_roster_entry_id: null,
      new_gid_group_key: `new-${index + 1}`,
      confidence: 0.5,
      candidates: [
        {
          rank: 1,
          person_cluster_id: existingGids[index % existingGids.length]!.id,
          roster_entry_id: null,
          confidence: 0.8,
        },
      ],
    }))
    const planned = planCappedGidResolutions({ decisions, tracklets, existingGids })

    expect(planned.allowedCount).toBe(6)
    expect([...planned.resolutions.values()]).toHaveLength(8)
    expect([...planned.resolutions.values()].every(row => row.createGroupKey === null)).toBe(true)
    expect(new Set([...planned.resolutions.values()].map(row => row.personClusterKey)).size).toBe(6)
  })

  it('permits a seventh GID only when seven same-team Local IDs share a frame', () => {
    const tracklets = Array.from({ length: 7 }, (_, index) => ({
      id: `tracklet-${index + 1}`,
      firstFrameIndex: 0n,
      lastFrameIndex: 10n,
      cannotLinkTrackletIds: Array.from({ length: 7 }, (_, peer) => `tracklet-${peer + 1}`).filter(
        id => id !== `tracklet-${index + 1}`,
      ),
    }))
    const decisions = tracklets.map((tracklet, index) => ({
      tracklet_id: tracklet.id,
      group_key: `group-${index + 1}`,
      action: 'CREATE_NEW_GID' as const,
      selected_person_cluster_id: null,
      selected_roster_entry_id: null,
      new_gid_group_key: `new-${index + 1}`,
      confidence: 0.5,
      candidates: [],
    }))
    const planned = planCappedGidResolutions({ decisions, tracklets, existingGids: [] })

    expect(planned.allowedCount).toBe(7)
    expect(new Set([...planned.resolutions.values()].map(row => row.personClusterKey)).size).toBe(7)
  })
})
