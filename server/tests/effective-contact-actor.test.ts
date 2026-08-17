import { describe, expect, it } from 'vitest'
import {
  resolveEffectiveContactActorRosterEntryId,
  type EffectiveContactActorAnalysis,
} from '../src/services/effective-contact-actor.js'

function analysis(
  overrides: Partial<EffectiveContactActorAnalysis> = {},
): EffectiveContactActorAnalysis {
  return {
    contactEvents: [
      {
        keyPointId: 'analysis-point',
        sourceKeyPointId: 'submission-point',
        sequenceIndex: 0,
        associationState: 'RESOLVED_SINGLE',
        actors: [{ trackId: 7, associationConfidence: 0.9 }],
      },
    ],
    contactActorCorrections: [],
    contactAssociationJobs: [],
    tracks: [{ trackId: 7, identityAssignments: [{ rosterEntryId: 'legacy-player' }] }],
    reidEvidenceSets: [],
    ...overrides,
  }
}

const semantic = {
  submissionKeyPointId: 'submission-point',
  ordinal: 1,
  actorRosterEntryId: null,
}

describe('resolveEffectiveContactActorRosterEntryId', () => {
  it('keeps a submitted human actor ahead of every analyzed association', () => {
    expect(
      resolveEffectiveContactActorRosterEntryId(analysis(), {
        ...semantic,
        actorRosterEntryId: 'human-player',
      }),
    ).toBe('human-player')
  })

  it('hydrates an unassigned submitted point from the effective analyzed actor', () => {
    expect(resolveEffectiveContactActorRosterEntryId(analysis(), semantic)).toBe('legacy-player')
  })

  it('uses the versioned ReID projection for corrected and aliased local tracks', () => {
    expect(
      resolveEffectiveContactActorRosterEntryId(
        analysis({
          contactActorCorrections: [{ keyPointId: 'analysis-point', trackId: 8 }],
          reidEvidenceSets: [
            {
              tracklets: [
                {
                  canonicalTrackId: 7,
                  trackIdAliases: [8],
                  activeProjection: {
                    assignmentRevision: { rosterEntryId: 'reid-player' },
                  },
                },
              ],
            },
          ],
        }),
        semantic,
      ),
    ).toBe('reid-player')
  })

  it('honors an explicit cleared correction instead of falling back to AI', () => {
    expect(
      resolveEffectiveContactActorRosterEntryId(
        analysis({
          contactActorCorrections: [{ keyPointId: 'analysis-point', trackId: null }],
        }),
        semantic,
      ),
    ).toBeNull()
  })

  it('does not reuse a stale completed projection after a newer association failed', () => {
    expect(
      resolveEffectiveContactActorRosterEntryId(
        analysis({
          contactAssociationJobs: [
            { keyPointId: 'submission-point', status: 'FAILED', projection: null },
            {
              keyPointId: 'submission-point',
              status: 'COMPLETED',
              projection: { trackId: 7 },
            },
          ],
        }),
        semantic,
      ),
    ).toBeNull()
  })
})
