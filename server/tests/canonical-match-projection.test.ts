import { describe, expect, it } from 'vitest'
import { projectCanonicalMatch } from '../src/services/canonical-match-projection.js'

const PAK = 'pak'
const IRI = 'iri'

function rally(
  id: string,
  time: number,
  scoringTeamId: string | null,
  options: { rawSetNumber?: number; reversed?: boolean; submitted?: boolean } = {},
) {
  return {
    id,
    rawSetNumber: options.rawSetNumber ?? 1,
    rawOrdinal: time,
    startCaptureTimeUs: BigInt(time),
    submitted: options.submitted ?? true,
    scoreResolutionState: scoringTeamId ? 'RESOLVED' : 'UNKNOWN',
    scoringTeamId,
    scoringCourtSide: null,
    baseLeftTeamId: PAK,
    baseRightTeamId: IRI,
    sideAssignmentReversed: options.reversed ?? false,
  }
}

describe('projectCanonicalMatch', () => {
  it('anchors a set winner to a stable rally while inserted rallies renumber around it', () => {
    const projection = projectCanonicalMatch({
      sets: [
        {
          id: 'set-legacy-4',
          setNumber: 4,
          winningTeamId: IRI,
          winningRallyId: 'rally-46',
        },
        { id: 'set-legacy-5', setNumber: 5, winningTeamId: null, winningRallyId: null },
      ],
      courtSideBoundaries: [
        {
          id: 'set-2-court-sides',
          effectiveRallyId: 'next-set-1',
          leftTeamId: IRI,
          rightTeamId: PAK,
        },
      ],
      segments: [
        rally('rally-1', 100, PAK, { rawSetNumber: 4 }),
        rally('inserted-before-winner', 150, IRI, { rawSetNumber: 5 }),
        rally('rally-46', 200, IRI, { rawSetNumber: 4 }),
        rally('next-set-1', 300, PAK, { rawSetNumber: 5, reversed: true }),
      ],
    })

    expect(projection.segmentById.get('rally-46')).toMatchObject({
      setNumber: 1,
      ordinal: 3,
      endsSet: true,
      winningTeamId: IRI,
    })
    expect(projection.segmentById.get('next-set-1')).toMatchObject({
      setNumber: 2,
      ordinal: 1,
      leftTeamId: IRI,
      rightTeamId: PAK,
    })
  })

  it('derives one score timeline for official and draft preview consumers', () => {
    const projection = projectCanonicalMatch({
      sets: [{ id: 'set-1', setNumber: 1, winningTeamId: null, winningRallyId: null }],
      segments: [rally('submitted', 100, PAK), rally('draft', 200, IRI, { submitted: false })],
    })

    expect(projection.segmentById.get('draft')).toMatchObject({
      ordinal: 2,
      leftScoreAfter: 1,
      rightScoreAfter: 1,
      officialLeftScoreAfter: 1,
      officialRightScoreAfter: 0,
    })
    expect(projection.sets[0]).toMatchObject({
      leftScore: 1,
      rightScore: 0,
      previewLeftScore: 1,
      previewRightScore: 1,
    })
  })

  it('falls back to the final rally in a legacy raw set when winnerRallyId is absent', () => {
    const projection = projectCanonicalMatch({
      sets: [
        { id: 'legacy-winner', setNumber: 7, winningTeamId: PAK },
        { id: 'legacy-open', setNumber: 8, winningTeamId: null },
      ],
      segments: [
        rally('legacy-a', 100, PAK, { rawSetNumber: 7 }),
        rally('legacy-b', 200, PAK, { rawSetNumber: 7 }),
        rally('legacy-next', 300, IRI, { rawSetNumber: 8, reversed: true }),
      ],
    })

    expect(projection.segmentById.get('legacy-b')?.endsSet).toBe(true)
    expect(projection.segmentById.get('legacy-next')).toMatchObject({ setNumber: 2, ordinal: 1 })
  })

  it('anchors court-side boundaries to rally ids when an earlier rally is inserted', () => {
    const projection = projectCanonicalMatch({
      sets: [{ id: 'set-1', setNumber: 1, winningTeamId: null, winningRallyId: null }],
      courtSideBoundaries: [
        {
          id: 'swap-at-rally-2',
          effectiveRallyId: 'rally-2',
          leftTeamId: IRI,
          rightTeamId: PAK,
        },
        {
          id: 'swap-back-at-rally-4',
          effectiveRallyId: 'rally-4',
          leftTeamId: PAK,
          rightTeamId: IRI,
        },
      ],
      segments: [
        rally('rally-1', 100, PAK),
        rally('inserted-before-swap', 150, IRI),
        rally('rally-2', 200, IRI),
        rally('rally-3', 300, PAK),
        rally('rally-4', 400, PAK),
      ],
    })

    expect(projection.segmentById.get('inserted-before-swap')).toMatchObject({
      leftTeamId: PAK,
      rightTeamId: IRI,
    })
    expect(projection.segmentById.get('rally-2')).toMatchObject({
      ordinal: 3,
      leftTeamId: IRI,
      rightTeamId: PAK,
    })
    expect(projection.segmentById.get('rally-3')).toMatchObject({
      leftTeamId: IRI,
      rightTeamId: PAK,
    })
    expect(projection.segmentById.get('rally-4')).toMatchObject({
      leftTeamId: PAK,
      rightTeamId: IRI,
    })
  })

  it('keeps the initial court sides until an explicit boundary overrides legacy rows', () => {
    const projection = projectCanonicalMatch({
      sets: [{ id: 'set-1', setNumber: 1, winningTeamId: null, winningRallyId: null }],
      courtSideBoundaries: [
        {
          id: 'official-set-2-sides',
          effectiveRallyId: 'rally-3',
          leftTeamId: IRI,
          rightTeamId: PAK,
        },
      ],
      segments: [
        rally('rally-1', 100, PAK),
        rally('legacy-row-that-used-to-look-swapped', 200, IRI, { reversed: true }),
        rally('rally-3', 300, IRI),
      ],
    })

    expect(projection.segmentById.get('rally-1')).toMatchObject({
      leftTeamId: PAK,
      rightTeamId: IRI,
    })
    expect(projection.segmentById.get('legacy-row-that-used-to-look-swapped')).toMatchObject({
      leftTeamId: PAK,
      rightTeamId: IRI,
    })
    expect(projection.segmentById.get('rally-3')).toMatchObject({
      leftTeamId: IRI,
      rightTeamId: PAK,
    })
  })

  it('does not expose a phantom trailing set from legacy open rows before winner rows', () => {
    const projection = projectCanonicalMatch({
      sets: [
        { id: 'legacy-open-1', setNumber: 1, winningTeamId: null },
        { id: 'legacy-open-2', setNumber: 2, winningTeamId: null },
        { id: 'winner-1', setNumber: 3, winningTeamId: IRI, winningRallyId: 'rally-1' },
        { id: 'winner-2', setNumber: 4, winningTeamId: PAK, winningRallyId: 'rally-2' },
      ],
      segments: [rally('rally-1', 100, IRI), rally('rally-2', 200, PAK)],
    })

    expect(projection.sets).toHaveLength(2)
    expect(projection.sets.map(set => set.winningTeamId)).toEqual([IRI, PAK])
  })

  it('keeps an explicitly created trailing open set after the last winner', () => {
    const projection = projectCanonicalMatch({
      sets: [
        { id: 'winner-1', setNumber: 1, winningTeamId: IRI, winningRallyId: 'rally-1' },
        { id: 'open-2', setNumber: 2, winningTeamId: null },
      ],
      segments: [rally('rally-1', 100, IRI)],
    })

    expect(projection.sets).toHaveLength(2)
    expect(projection.sets[1]).toMatchObject({
      setNumber: 2,
      rallyIds: [],
      winningTeamId: null,
    })
  })
})
