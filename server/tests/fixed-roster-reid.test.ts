import { describe, expect, it } from 'vitest'
import {
  FixedRosterReidError,
  parseFixedRosterReidExtension,
  selectNestedCandidate,
  solveSlots,
  type HistoricalRow,
} from '../src/services/fixed-roster-reid.js'

const descriptor = (dimension: number, index = 0) => {
  const bytes = Buffer.alloc(dimension * 4)
  bytes.writeFloatLE(1, index * 4)
  return bytes.toString('base64')
}

function resultWithFixedRoster() {
  const descriptors = {
    dino: descriptor(384),
    osnet: descriptor(512),
    kpr: descriptor(4096),
    kpr_prompt: descriptor(4096),
  }
  return {
    tracks: [
      { track_id: 7, court_side: 'left', first_frame_index: '0', last_frame_index: '120' },
      { track_id: 8, court_side: 'left', first_frame_index: '0', last_frame_index: '120' },
    ],
    extensions: {
      fixed_roster_reid: {
        schema_version: '2.0.0',
        scope: 'clip',
        identity_contract: 'fixed-six-per-team',
        slots_per_team: 6,
        descriptor_recipe: {
          name: 'nested-part-adaptation',
          version: '1.0.0',
          selection_protocol: 'past-only-nested-leave-one-clip-out',
          roster_contract: 'fixed-six-per-team',
          modalities: [],
        },
        tracklets: [
          {
            canonical_track_id: 7,
            track_ids: [7],
            court_side: 'left',
            median_court_pos: [0.2, 0.4],
            first_frame_index: '0',
            last_frame_index: '120',
            sample_count: 24,
            mean_quality: 0.9,
            prompt_coverage: 1,
            descriptors,
            cannot_link_canonical_track_ids: [8],
          },
          {
            canonical_track_id: 8,
            track_ids: [8],
            court_side: 'left',
            median_court_pos: [0.3, 0.6],
            first_frame_index: '0',
            last_frame_index: '120',
            sample_count: 24,
            mean_quality: 0.9,
            prompt_coverage: 1,
            descriptors,
            cannot_link_canonical_track_ids: [7],
          },
        ],
      },
    },
  } as Record<string, unknown>
}

describe('fixed roster Nested Part ReID', () => {
  it('hard-cuts the old optional extension and accepts exact v2 descriptors', () => {
    expect(
      parseFixedRosterReidExtension({ tracks: [], extensions: { reid_feature_bank: {} } }),
    ).toBeNull()
    const parsed = parseFixedRosterReidExtension(resultWithFixedRoster())
    expect(parsed).toMatchObject({ schemaVersion: '2.0.0', slotsPerTeam: 6 })
    expect(parsed?.tracklets[0]?.descriptors?.dino).toHaveLength(384)
    expect(parsed?.tracklets.map(tracklet => tracklet.canonicalTrackId)).toEqual([7, 8])
  })

  it('rejects malformed vectors and asymmetric co-visibility', () => {
    const malformed = resultWithFixedRoster() as any
    malformed.extensions.fixed_roster_reid.tracklets[0].descriptors.dino = descriptor(383)
    expect(() => parseFixedRosterReidExtension(malformed)).toThrow(FixedRosterReidError)

    const asymmetric = resultWithFixedRoster() as any
    asymmetric.extensions.fixed_roster_reid.tracklets[1].cannot_link_canonical_track_ids = []
    expect(() => parseFixedRosterReidExtension(asymmetric)).toThrow(FixedRosterReidError)
  })

  it('uses KPR Prompt until enough past clips exist and never reads a query clip', () => {
    const descriptors = (left: boolean) => ({
      dino: left ? [1, 0] : [0, 1],
      osnet: left ? [1, 0] : [0, 1],
      kpr: left ? [1, 0] : [0, 1],
      kpr_prompt: left ? [1, 0] : [0, 1],
    })
    const shortHistory: HistoricalRow[] = [
      { clipId: 'clip-1', label: 'S1', descriptors: descriptors(true) },
      { clipId: 'clip-2', label: 'S1', descriptors: descriptors(true) },
    ]
    expect(selectNestedCandidate(shortHistory)).toEqual({
      modalities: ['kpr_prompt'],
      regularization: 0.1,
      kernel: 'linear',
    })
    const history = [
      ...shortHistory,
      { clipId: 'clip-1', label: 'S2', descriptors: descriptors(false) },
      { clipId: 'clip-2', label: 'S2', descriptors: descriptors(false) },
      { clipId: 'clip-3', label: 'S1', descriptors: descriptors(true) },
      { clipId: 'clip-3', label: 'S2', descriptors: descriptors(false) },
    ]
    expect(selectNestedCandidate(history).modalities.length).toBeGreaterThan(0)
  })

  it('keeps a seventh overlapping detector track unassigned instead of inventing S7', () => {
    const slots = Array.from({ length: 6 }, (_, index) => ({
      id: `slot-${index + 1}`,
      label: `S${index + 1}`,
      slotIndex: index + 1,
      teamId: 'team-1',
    }))
    const tracklets = Array.from({ length: 7 }, (_, index) => ({
      canonicalTrackId: index + 1,
      trackIds: [index + 1],
      cannotLinkCanonicalTrackIds: Array.from({ length: 7 }, (_, linked) => linked + 1).filter(
        linked => linked !== index + 1,
      ),
      sampleCount: 100 - index,
    }))
    const candidates = new Map(tracklets.map(tracklet => [tracklet.canonicalTrackId, slots]))
    const fixed = new Map(
      tracklets.slice(0, 6).map((tracklet, index) => [tracklet.canonicalTrackId, slots[index]!.id]),
    )

    const assignment = solveSlots(tracklets as any, candidates, new Map(), fixed)

    expect(assignment.size).toBe(6)
    expect(assignment.has(7)).toBe(false)
  })

  it('solves many non-overlapping tracklets without exhaustive slot permutations', () => {
    const slots = Array.from({ length: 6 }, (_, index) => ({
      id: `slot-${index + 1}`,
      label: `S${index + 1}`,
      slotIndex: index + 1,
      teamId: 'team-1',
    }))
    const tracklets = Array.from({ length: 48 }, (_, index) => ({
      canonicalTrackId: index + 1,
      trackIds: [index + 1],
      cannotLinkCanonicalTrackIds: [],
      sampleCount: 100 - index,
    }))
    const candidates = new Map(tracklets.map(tracklet => [tracklet.canonicalTrackId, slots]))
    const scores = new Map(
      tracklets.flatMap(tracklet =>
        slots.map(
          slot =>
            [
              `${tracklet.canonicalTrackId}:${slot.id}`,
              slot.slotIndex === (tracklet.canonicalTrackId % 6) + 1 ? 1 : 0,
            ] as const,
        ),
      ),
    )

    const assignment = solveSlots(tracklets as any, candidates, scores)

    expect(assignment.size).toBe(48)
    expect(assignment.get(1)).toBe('slot-2')
    expect(assignment.get(48)).toBe('slot-1')
  })

  it('keeps a bounded valid roster for a pathological all-overlapping graph', () => {
    const slots = Array.from({ length: 6 }, (_, index) => ({
      id: `slot-${index + 1}`,
      label: `S${index + 1}`,
      slotIndex: index + 1,
      teamId: 'team-1',
    }))
    const tracklets = Array.from({ length: 42 }, (_, index) => ({
      canonicalTrackId: index + 1,
      trackIds: [index + 1],
      cannotLinkCanonicalTrackIds: Array.from({ length: 42 }, (_, linked) => linked + 1).filter(
        linked => linked !== index + 1,
      ),
      sampleCount: 100 - index,
    }))
    const candidates = new Map(tracklets.map(tracklet => [tracklet.canonicalTrackId, slots]))

    const assignment = solveSlots(tracklets as any, candidates, new Map())

    expect(assignment.size).toBe(6)
    expect([...assignment.keys()]).toEqual([1, 2, 3, 4, 5, 6])
  })
})
