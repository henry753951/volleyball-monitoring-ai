import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  pgvectorLiteralFromDescriptor,
  planReidFeatureRows,
  sameCanonicalTrackCoverage,
} from '../src/roles/reid-feature-worker.js'

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const trackletOne = '30000000-0000-4000-8000-000000000001'
const trackletTwo = '30000000-0000-4000-8000-000000000002'
const vectorOne = '30000000-0000-4000-8000-000000000003'
const vectorTwo = '30000000-0000-4000-8000-000000000004'

function fixture() {
  const first = Buffer.alloc(8)
  first.writeFloatLE(0.5, 0)
  first.writeFloatLE(-0.5, 4)
  const second = Buffer.alloc(8)
  second.writeFloatLE(0.25, 0)
  second.writeFloatLE(0.75, 4)
  const descriptor = Buffer.concat([first, second])
  const rawResponse = '{"jersey_number":11}'
  const rawResponseSha = sha(rawResponse)
  const result = {
    tracklets: [
      {
        tracklet_id: trackletOne,
        canonical_track_id: 17,
        track_id_aliases: [17],
        court_side: 'LEFT',
        first_frame_index: '0',
        last_frame_index: '20',
        cannot_link_tracklet_ids: [trackletTwo],
        vectors: [
          {
            vector_id: vectorOne,
            modality: 'DINO',
            model_namespace: 'dino/v1',
            dimension: 2,
            normalization: 'L2',
            distance: 'COSINE',
            byte_offset: '0',
            byte_length: '8',
            sha256: sha(first),
            source_frame_indices: ['4'],
          },
        ],
        jersey_vlm: {
          model_namespace: 'vlm/v1',
          raw_response_key: 'tracklet-one-vlm',
          raw_response_sha256: rawResponseSha,
          candidate_numbers: [11],
          selected_frame_indices: ['4'],
        },
      },
      {
        tracklet_id: trackletTwo,
        canonical_track_id: 18,
        track_id_aliases: [18],
        court_side: 'LEFT',
        first_frame_index: '0',
        last_frame_index: '20',
        cannot_link_tracklet_ids: [trackletOne],
        vectors: [
          {
            vector_id: vectorTwo,
            modality: 'DINO',
            model_namespace: 'dino/v1',
            dimension: 2,
            normalization: 'L2',
            distance: 'COSINE',
            byte_offset: '8',
            byte_length: '8',
            sha256: sha(second),
            source_frame_indices: ['8'],
          },
        ],
        jersey_vlm: null,
      },
    ],
  }
  const jersey = {
    responses: [
      {
        response_key: 'tracklet-one-vlm',
        tracklet_id: trackletOne,
        model_namespace: 'vlm/v1',
        raw_response: rawResponse,
        raw_response_sha256: rawResponseSha,
        candidate_numbers: [11],
        selected_frame_indices: ['4'],
      },
    ],
  }
  return { descriptor, result, jersey }
}

describe('ReID feature evidence materialization plan', () => {
  it('activates a rebuild only when canonical track coverage is unchanged', () => {
    expect(sameCanonicalTrackCoverage([9, 3, 9], [3, 9])).toBe(true)
    expect(sameCanonicalTrackCoverage([3, 9], [3])).toBe(false)
    expect(sameCanonicalTrackCoverage([], [])).toBe(false)
  })

  it('verifies exact descriptor slices, saved VLM responses, and symmetric co-visibility', () => {
    const { descriptor, result, jersey } = fixture()
    const rows = planReidFeatureRows(result, descriptor, new Set([17, 18]), jersey)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.vectors[0]!.sourceFrameIndices).toEqual([4n])
    expect(rows[0]!.jersey?.rawResponseKey).toBe('tracklet-one-vlm')
  })

  it('rejects descriptor corruption and one-sided cannot-links', () => {
    const corrupted = fixture()
    corrupted.descriptor[0] ^= 0xff
    expect(() =>
      planReidFeatureRows(
        corrupted.result,
        corrupted.descriptor,
        new Set([17, 18]),
        corrupted.jersey,
      ),
    ).toThrow(/vector hash/)

    const asymmetric = fixture()
    asymmetric.result.tracklets[1]!.cannot_link_tracklet_ids = []
    expect(() =>
      planReidFeatureRows(
        asymmetric.result,
        asymmetric.descriptor,
        new Set([17, 18]),
        asymmetric.jersey,
      ),
    ).toThrow(/symmetric/)
  })

  it('indexes supported compact descriptors while keeping 4096D KPR in immutable artifacts', () => {
    const { descriptor } = fixture()
    expect(
      pgvectorLiteralFromDescriptor(descriptor, {
        dimension: 2,
        byteOffset: 0n,
        byteLength: 8n,
      }),
    ).toBe('[0.5,-0.5]')
    expect(
      pgvectorLiteralFromDescriptor(Buffer.alloc(0), {
        dimension: 4_096,
        byteOffset: 0n,
        byteLength: 16_384n,
      }),
    ).toBeNull()
  })
})
