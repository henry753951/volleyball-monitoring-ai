import { JobStatus, ReidEvidenceState } from '@volleyball-monitoring/db/client'
import { describe, expect, it } from 'vitest'
import {
  hasReidAssociationRevision,
  isReidBankSeedMembership,
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

  it('does not feed current-rally automatic evidence back into its own association', () => {
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
    ).toBe(false)
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
              derivationVersion: 'human-confirmed-seed-v4',
            },
          },
        ],
        'team-a',
        13n,
      ),
    ).toBe(false)
  })
})
