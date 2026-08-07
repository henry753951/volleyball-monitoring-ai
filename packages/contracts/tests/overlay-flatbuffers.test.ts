import { describe, expect, it } from 'vitest'
import {
  chunkProviderOverlay,
  encodeBrowserOverlayChunk,
  parseBrowserOverlayChunk,
  parseProviderOverlaySequence,
  type ProviderOverlaySequence,
} from '../src/overlay-flatbuffers.js'

function sequence(): ProviderOverlaySequence {
  return {
    schemaVersion: 10_000,
    aiJobId: 'job', rallySubmissionId: 'submission', rallyId: 'rally', matchId: 'match', annotationRevision: 8n, clipAssetId: 'clip', analysisId: 'analysis', analysisVersion: 'v1',
    videoWidth: 1920, videoHeight: 1080, fpsNum: 60, fpsDen: 1, totalFrames: 3n,
    frameOffsets: [0, 1, 1, 2], trackIds: [7, 9],
    frameBboxes: [{ x1: 1, y1: 2, x2: 3, y2: 4 }, { x1: 5, y1: 6, x2: 7, y2: 8 }],
    frameFootPositions: [{ x: 2, y: 4 }, { x: 6, y: 8 }],
    courtPositions: [{ x: -0.2, y: 1.3 }, { x: 0.4, y: 0.5 }],
    playerFlags: [1, 0], playerConfidences: [200, 255], actionTaxonomyId: '', actionTaxonomyVersion: '', actionLabels: [], actionLabelIds: [65_535, 65_535], actionConfidences: [255, 255],
    ballFramePositions: [{ x: 10, y: 20 }, { x: 0, y: 0 }, { x: 30, y: 40 }], ballFlags: [1, 0, 1], ballConfidences: [220, 0, 210],
  }
}

describe('overlay FlatBuffers boundary', () => {
  it('accepts the minimal empty VOV1 used by the honest fake provider', () => {
    const bytes = new Uint8Array([12, 0, 0, 0, 86, 79, 86, 49, 4, 0, 4, 0, 4, 0, 0, 0])
    expect(parseProviderOverlaySequence(bytes)).toMatchObject({ schemaVersion: 10_000, totalFrames: 0n, frameOffsets: [0] })
  })

  it('splits by frame and round-trips strict VOC1 columns without clamping court coordinates', () => {
    const chunks = chunkProviderOverlay(sequence(), 2)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toMatchObject({ chunkIndex: 0, startFrameIndex: 0n, frameCount: 2, frameOffsets: [0, 1, 1], trackIds: [7], courtPositions: [{ x: -0.2, y: 1.3 }] })
    expect(chunks[1]).toMatchObject({ chunkIndex: 1, startFrameIndex: 2n, frameCount: 1, frameOffsets: [0, 1], trackIds: [9] })
    const decoded = parseBrowserOverlayChunk(encodeBrowserOverlayChunk(chunks[0]!))
    expect(decoded).toMatchObject({ analysisId: 'analysis', overlayVersion: '1', chunkIndex: 0, startFrameIndex: 0n, frameCount: 2, frameOffsets: [0, 1, 1], trackIds: [7] })
    expect(decoded.courtPositions[0]!.x).toBeCloseTo(-0.2)
    expect(decoded.courtPositions[0]!.y).toBeCloseTo(1.3)
  })

  it('rejects malformed column lengths before encoding', () => {
    const chunk = chunkProviderOverlay(sequence(), 2)[0]!
    chunk.playerFlags = []
    expect(() => encodeBrowserOverlayChunk(chunk)).toThrow(/playerFlags/)
  })
})
