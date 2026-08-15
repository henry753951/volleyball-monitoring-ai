export const CONTACT_ASSOCIATION_ALGORITHM = 'contact-association/coco17-pose-first-v1'
const KEYPOINT_CONFIDENCE = 0.3
const MAX_NORMALIZED_ARM_DISTANCE = 0.45
const MIN_RUNNER_UP_MARGIN = 0.08
const ACTION_BONUS = 0.03
const SEGMENT_EPSILON = 1e-12
const CONTACT_ACTIONS = new Set(['spiking', 'passing', 'setting', 'digging'])

export interface NormalizedPoint {
  x: number
  y: number
}

export interface NormalizedBBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface ContactAssociationPlayer {
  trackId: number
  bbox: NormalizedBBox
  action: string | null
}

export interface ContactAssociationPose {
  trackId: number
  status: 'AVAILABLE' | 'NO_USABLE_BBOX' | 'INFERENCE_FAILED' | 'LOW_QUALITY'
  bbox: NormalizedBBox
  bboxSource: 'DETECTOR' | 'TRACKER_PROPAGATED'
  keypoints: ReadonlyArray<{ x: number; y: number; confidence: number }>
}

export interface ContactAssociationInput {
  frameIndex: bigint
  videoWidth: number
  videoHeight: number
  ball: NormalizedPoint | null
  players: ContactAssociationPlayer[]
  poses: ContactAssociationPose[]
  poseRecipeNamespace: string | null
  poseEvidenceFallbackReason?: string | null
}

export interface ContactAssociationResult {
  trackId: number | null
  observationFrameIndex: bigint | null
  source: 'POSE_HAND' | 'BBOX_ACTION' | 'BBOX_SPATIAL' | 'UNRESOLVED'
  confidence: number | null
  poseRecipeNamespace: string | null
  fallbackReason: string | null
  evidence: Record<string, unknown>
}

function pointSegmentDistance(
  point: NormalizedPoint,
  start: NormalizedPoint,
  end: NormalizedPoint,
) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const denominator = dx * dx + dy * dy
  if (denominator <= SEGMENT_EPSILON) return Math.hypot(point.x - start.x, point.y - start.y)
  const projection = Math.min(
    1,
    Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator),
  )
  return Math.hypot(point.x - (start.x + projection * dx), point.y - (start.y + projection * dy))
}

function armDistance(ball: NormalizedPoint, pose: ContactAssociationPose) {
  if (pose.status !== 'AVAILABLE' || pose.keypoints.length !== 17) return null
  const diagonal = Math.max(
    Math.hypot(pose.bbox.x2 - pose.bbox.x1, pose.bbox.y2 - pose.bbox.y1),
    1e-6,
  )
  const candidates: Array<{
    distance: number
    geometry: string
    wristConfidence: number
    elbowConfidence: number
  }> = []
  for (const [side, elbowIndex, wristIndex] of [
    ['left', 7, 9],
    ['right', 8, 10],
  ] as const) {
    const elbow = pose.keypoints[elbowIndex]!
    const wrist = pose.keypoints[wristIndex]!
    if (wrist.confidence < KEYPOINT_CONFIDENCE) continue
    candidates.push({
      distance: Math.hypot(ball.x - wrist.x, ball.y - wrist.y),
      geometry: `${side}_wrist`,
      wristConfidence: wrist.confidence,
      elbowConfidence: elbow.confidence,
    })
    if (elbow.confidence >= KEYPOINT_CONFIDENCE)
      candidates.push({
        distance: pointSegmentDistance(ball, elbow, wrist),
        geometry: `${side}_forearm`,
        wristConfidence: wrist.confidence,
        elbowConfidence: elbow.confidence,
      })
  }
  if (!candidates.length) return null
  candidates.sort(
    (left, right) => left.distance - right.distance || left.geometry.localeCompare(right.geometry),
  )
  const best = candidates[0]!
  return {
    normalizedDistance: best.distance / diagonal,
    rawVideoDistance: best.distance,
    bboxDiagonal: diagonal,
    geometry: best.geometry,
    wristConfidence: best.wristConfidence,
    elbowConfidence: best.elbowConfidence,
    bboxSource: pose.bboxSource,
  }
}

function iou(first: NormalizedBBox, second: NormalizedBBox) {
  const left = Math.max(first.x1, second.x1)
  const top = Math.max(first.y1, second.y1)
  const right = Math.min(first.x2, second.x2)
  const bottom = Math.min(first.y2, second.y2)
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top)
  const firstArea = Math.max(0, first.x2 - first.x1) * Math.max(0, first.y2 - first.y1)
  const secondArea = Math.max(0, second.x2 - second.x1) * Math.max(0, second.y2 - second.y1)
  const union = firstArea + secondArea - intersection
  return intersection > 0 && union > 0 ? intersection / union : 0
}

function playerBallScore(
  ball: NormalizedPoint,
  player: ContactAssociationPlayer,
  videoWidth: number,
  videoHeight: number,
  actionAware: boolean,
) {
  const radiusPixels = Math.max(4, Math.min(videoWidth, videoHeight) * 0.018)
  const radiusX = radiusPixels / videoWidth
  const radiusY = radiusPixels / videoHeight
  const ballBox = {
    x1: ball.x - radiusX,
    y1: ball.y - radiusY,
    x2: ball.x + radiusX,
    y2: ball.y + radiusY,
  }
  const { x1, y1, x2, y2 } = player.bbox
  const width = Math.max(1 / videoWidth, x2 - x1)
  const height = Math.max(1 / videoHeight, y2 - y1)
  const horizontalMargin = Math.max(radiusX, width * 0.35)
  const action = player.action?.toLowerCase() ?? null
  let expanded: NormalizedBBox
  if (actionAware && (action === 'spiking' || action === 'setting'))
    expanded = {
      x1: x1 - horizontalMargin,
      y1: y1 - Math.max(radiusY, height * 0.5),
      x2: x2 + horizontalMargin,
      y2: y1 + height * 0.65,
    }
  else if (actionAware && (action === 'passing' || action === 'digging'))
    expanded = {
      x1: x1 - horizontalMargin,
      y1: y1 + height * 0.1,
      x2: x2 + horizontalMargin,
      y2: y2 + Math.max(radiusY, height * 0.2),
    }
  else
    expanded = {
      x1: x1 - horizontalMargin,
      y1: y1 - Math.max(radiusY, height * 0.35),
      x2: x2 + horizontalMargin,
      y2: y2 + Math.max(radiusY, height * 0.35),
    }
  return iou(ballBox, expanded)
}

export function associateContactActor(input: ContactAssociationInput): ContactAssociationResult {
  const audit: Record<string, unknown> = {
    algorithm_namespace: CONTACT_ASSOCIATION_ALGORITHM,
    frame_index: input.frameIndex.toString(),
    pose_recipe_namespace: input.poseRecipeNamespace,
    absolute_distance_gate: MAX_NORMALIZED_ARM_DISTANCE,
    runner_up_margin_gate: MIN_RUNNER_UP_MARGIN,
  }
  if (!input.ball) {
    const fallbackReason = 'ball_missing_at_corrected_frame'
    return {
      trackId: null,
      observationFrameIndex: null,
      source: 'UNRESOLVED',
      confidence: null,
      poseRecipeNamespace: input.poseRecipeNamespace,
      fallbackReason,
      evidence: { ...audit, pose_fallback_reason: fallbackReason },
    }
  }

  const playersByTrack = new Map(input.players.map(player => [player.trackId, player]))
  const poseCandidates = input.poses
    .map(pose => {
      const player = playersByTrack.get(pose.trackId)
      const geometry = player ? armDistance(input.ball!, pose) : null
      if (!player || !geometry) return null
      const actionBonus =
        player.action && CONTACT_ACTIONS.has(player.action.toLowerCase()) ? ACTION_BONUS : 0
      return {
        trackId: pose.trackId,
        rankScore: geometry.normalizedDistance - actionBonus,
        action: player.action,
        actionBonus,
        ...geometry,
      }
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((left, right) => left.rankScore - right.rankScore || left.trackId - right.trackId)
  const bestPose = poseCandidates[0]
  const runnerUp = poseCandidates.find(candidate => candidate.trackId !== bestPose?.trackId)
  const margin = bestPose && runnerUp ? runnerUp.rankScore - bestPose.rankScore : null
  let poseFallbackReason = input.poseEvidenceFallbackReason ?? null
  if (!poseFallbackReason) {
    if (!bestPose) poseFallbackReason = 'no_reliable_arm_keypoints'
    else if (bestPose.normalizedDistance > MAX_NORMALIZED_ARM_DISTANCE)
      poseFallbackReason = 'outside_distance_gate'
    else if (margin !== null && margin < MIN_RUNNER_UP_MARGIN)
      poseFallbackReason = 'ambiguous_runner_up'
  }
  Object.assign(audit, {
    pose_candidates: poseCandidates,
    runner_up_margin: margin,
    pose_fallback_reason: poseFallbackReason,
  })
  if (bestPose && !poseFallbackReason)
    return {
      trackId: bestPose.trackId,
      observationFrameIndex: input.frameIndex,
      source: 'POSE_HAND',
      confidence: Math.max(
        0,
        Math.min(1, 1 - bestPose.normalizedDistance / MAX_NORMALIZED_ARM_DISTANCE),
      ),
      poseRecipeNamespace: input.poseRecipeNamespace,
      fallbackReason: null,
      evidence: audit,
    }

  const actionCandidates = input.players
    .filter(player => player.action && CONTACT_ACTIONS.has(player.action.toLowerCase()))
    .map(player => ({
      trackId: player.trackId,
      action: player.action,
      score: playerBallScore(input.ball!, player, input.videoWidth, input.videoHeight, true),
    }))
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.trackId - right.trackId)
  if (actionCandidates.length) {
    const best = actionCandidates[0]!
    return {
      trackId: best.trackId,
      observationFrameIndex: input.frameIndex,
      source: 'BBOX_ACTION',
      confidence: best.score,
      poseRecipeNamespace: input.poseRecipeNamespace,
      fallbackReason: poseFallbackReason,
      evidence: { ...audit, bbox_candidates: actionCandidates },
    }
  }

  const bboxCandidates = input.players
    .map(player => ({
      trackId: player.trackId,
      score: playerBallScore(input.ball!, player, input.videoWidth, input.videoHeight, false),
    }))
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.trackId - right.trackId)
  if (bboxCandidates.length) {
    const best = bboxCandidates[0]!
    return {
      trackId: best.trackId,
      observationFrameIndex: input.frameIndex,
      source: 'BBOX_SPATIAL',
      confidence: best.score,
      poseRecipeNamespace: input.poseRecipeNamespace,
      fallbackReason: poseFallbackReason,
      evidence: { ...audit, bbox_candidates: bboxCandidates },
    }
  }
  return {
    trackId: null,
    observationFrameIndex: input.frameIndex,
    source: 'UNRESOLVED',
    confidence: null,
    poseRecipeNamespace: input.poseRecipeNamespace,
    fallbackReason: poseFallbackReason ?? 'no_player_near_ball',
    evidence: { ...audit, bbox_candidates: [] },
  }
}
