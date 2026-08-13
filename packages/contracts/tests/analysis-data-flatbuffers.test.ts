import { describe, expect, it } from 'vitest'
import {
  chunkAnalysisData,
  encodeAnalysisFrameChunk,
  parseAnalysisFrameChunk,
  type AnalysisData,
} from '../src/analysis-data-flatbuffers.js'

function analysisData(): AnalysisData {
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
    courtKeypointFrameOffsets: [0, 2, 2, 3], courtKeypointIds: [0, 11, 35],
    courtKeypointPositions: [{ x: 100, y: 200 }, { x: 300, y: 400 }, { x: 500, y: 600 }], courtKeypointConfidences: [230, 210, 190],
    domainJson: '{}', inputClipSha256: 'a'.repeat(64), producerName: 'test', producerBuildId: 'test-build', producerSdkVersion: 'test-sdk', executionManifestJson: '{}',
  }
}

describe('AnalysisData FlatBuffers boundary', () => {
  it('splits by frame and round-trips strict VFC1 columns without clamping court coordinates', () => {
    const chunks = chunkAnalysisData(analysisData(), 2)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toMatchObject({ chunkIndex: 0, startFrameIndex: 0n, frameCount: 2, frameOffsets: [0, 1, 1], trackIds: [7], courtPositions: [{ x: -0.2, y: 1.3 }], courtKeypointFrameOffsets: [0, 2, 2], courtKeypointIds: [0, 11] })
    expect(chunks[1]).toMatchObject({ chunkIndex: 1, startFrameIndex: 2n, frameCount: 1, frameOffsets: [0, 1], trackIds: [9], courtKeypointFrameOffsets: [0, 1], courtKeypointIds: [35] })
    const decoded = parseAnalysisFrameChunk(encodeAnalysisFrameChunk(chunks[0]!))
    expect(decoded).toMatchObject({ analysisId: 'analysis', analysisDataVersion: '1', chunkIndex: 0, startFrameIndex: 0n, frameCount: 2, frameOffsets: [0, 1, 1], trackIds: [7], courtKeypointFrameOffsets: [0, 2, 2], courtKeypointIds: [0, 11] })
    expect(decoded.courtPositions[0]!.x).toBeCloseTo(-0.2)
    expect(decoded.courtPositions[0]!.y).toBeCloseTo(1.3)
  })

  it('rejects malformed column lengths before encoding', () => {
    const chunk = chunkAnalysisData(analysisData(), 2)[0]!
    chunk.playerFlags = []
    expect(() => encodeAnalysisFrameChunk(chunk)).toThrow(/playerFlags/)
  })
})
