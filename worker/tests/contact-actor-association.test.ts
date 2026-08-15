import { describe, expect, it } from 'vitest'
import {
  associateContactActor,
  type ContactAssociationPose,
} from '../src/services/contact-actor-association.js'

function pose(trackId: number, wristX: number): ContactAssociationPose {
  const keypoints = Array.from({ length: 17 }, () => ({ x: -1, y: -1, confidence: -1 }))
  keypoints[7] = { x: wristX, y: 0.51, confidence: 0.9 }
  keypoints[9] = { x: wristX, y: 0.45, confidence: 0.95 }
  return {
    trackId,
    status: 'AVAILABLE',
    bbox: { x1: wristX - 0.1, y1: 0.25, x2: wristX + 0.1, y2: 0.85 },
    bboxSource: 'DETECTOR',
    keypoints,
  }
}

const players = [
  { trackId: 1, bbox: { x1: 0.4, y1: 0.25, x2: 0.6, y2: 0.85 }, action: null },
  { trackId: 2, bbox: { x1: 0.65, y1: 0.25, x2: 0.85, y2: 0.85 }, action: 'Spiking' },
]

describe('durable corrected-contact association', () => {
  it('uses saved wrist/forearm evidence before a stronger action bbox cue', () => {
    const result = associateContactActor({
      frameIndex: 42n,
      videoWidth: 1920,
      videoHeight: 1080,
      ball: { x: 0.5, y: 0.45 },
      players,
      poses: [pose(1, 0.505), pose(2, 0.72)],
      poseRecipeNamespace: 'person-pose/coco17-v1',
    })
    expect(result).toMatchObject({
      trackId: 1,
      observationFrameIndex: 42n,
      source: 'POSE_HAND',
      fallbackReason: null,
    })
  })

  it('abstains on ambiguous pose and degrades to the action-aware bbox', () => {
    const result = associateContactActor({
      frameIndex: 42n,
      videoWidth: 1920,
      videoHeight: 1080,
      ball: { x: 0.66, y: 0.45 },
      players,
      poses: [pose(1, 0.65), pose(2, 0.67)],
      poseRecipeNamespace: 'person-pose/coco17-v1',
    })
    expect(result).toMatchObject({
      trackId: 2,
      source: 'BBOX_ACTION',
      fallbackReason: 'ambiguous_runner_up',
    })
  })

  it('returns unresolved instead of inventing an actor when the corrected frame has no ball', () => {
    const result = associateContactActor({
      frameIndex: 42n,
      videoWidth: 1920,
      videoHeight: 1080,
      ball: null,
      players,
      poses: [pose(1, 0.5)],
      poseRecipeNamespace: 'person-pose/coco17-v1',
    })
    expect(result).toMatchObject({
      trackId: null,
      source: 'UNRESOLVED',
      fallbackReason: 'ball_missing_at_corrected_frame',
    })
  })
})
