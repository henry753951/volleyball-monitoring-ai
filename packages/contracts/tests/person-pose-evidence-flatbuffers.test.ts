import { describe, expect, it } from 'vitest'
import {
  encodePersonPoseEvidenceChunk,
  parsePersonPoseEvidenceChunk,
  PERSON_POSE_BBOX_SOURCE,
  PERSON_POSE_KEYPOINT_COUNT,
  PERSON_POSE_OBSERVATION_HASH_BYTES,
  PERSON_POSE_STATUS,
  type PersonPoseEvidenceChunk,
} from '../src/person-pose-evidence-flatbuffers.js'

function evidence(): PersonPoseEvidenceChunk {
  const keypoints = PERSON_POSE_KEYPOINT_COUNT * 2
  return {
    schemaVersion: '1.0.0',
    analysisRunId: 'analysis-run',
    poseRecipeNamespace: 'coco17/test-v1',
    startFrameIndex: 120n,
    frameCount: 2,
    frameOffsets: [0, 2, 2],
    trackIds: [7, 9],
    bboxSources: [PERSON_POSE_BBOX_SOURCE.detector, PERSON_POSE_BBOX_SOURCE.trackerPropagated],
    bboxX1: [0.1, 0.5],
    bboxY1: [0.2, 0.2],
    bboxX2: [0.4, 0.8],
    bboxY2: [0.9, 0.9],
    cropScaleX: [1 / 1920, 1 / 1920],
    cropScaleY: [1 / 1080, 1 / 1080],
    cropOffsetX: [0.1, 0.5],
    cropOffsetY: [0.2, 0.2],
    statuses: [PERSON_POSE_STATUS.available, PERSON_POSE_STATUS.lowQuality],
    observationSha256: Array.from(
      { length: PERSON_POSE_OBSERVATION_HASH_BYTES * 2 },
      (_, index) => index,
    ),
    keypointX: Array.from({ length: keypoints }, (_, index) => index / keypoints),
    keypointY: Array.from({ length: keypoints }, (_, index) => 1 - index / keypoints),
    keypointConfidence: Array.from({ length: keypoints }, (_, index) =>
      index < PERSON_POSE_KEYPOINT_COUNT ? 0.9 : -1,
    ),
  }
}

describe('person pose evidence FlatBuffers boundary', () => {
  it('round-trips every-frame VPE1 columns without losing normalized keypoints', () => {
    const decoded = parsePersonPoseEvidenceChunk(encodePersonPoseEvidenceChunk(evidence()))
    expect(decoded).toMatchObject({
      schemaVersion: '1.0.0',
      analysisRunId: 'analysis-run',
      poseRecipeNamespace: 'coco17/test-v1',
      startFrameIndex: 120n,
      frameCount: 2,
      frameOffsets: [0, 2, 2],
      trackIds: [7, 9],
      statuses: [PERSON_POSE_STATUS.available, PERSON_POSE_STATUS.lowQuality],
    })
    expect(decoded.keypointX[9]).toBeCloseTo(evidence().keypointX[9]!)
    expect(decoded.keypointConfidence[PERSON_POSE_KEYPOINT_COUNT]).toBe(-1)
  })

  it('rejects a pose column that does not cover every observation', () => {
    const malformed = evidence()
    malformed.bboxX1 = [0.1]
    expect(() => encodePersonPoseEvidenceChunk(malformed)).toThrow(/bboxX1/)
  })
})
