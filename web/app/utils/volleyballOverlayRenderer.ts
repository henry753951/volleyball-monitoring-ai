import {
  ANALYSIS_BALL_FLAG,
  ANALYSIS_MISSING_ACTION_LABEL,
  ANALYSIS_MISSING_CONFIDENCE,
  ANALYSIS_PLAYER_FLAG,
  type AnalysisFrameChunk,
} from '@volleyball-monitoring/contracts'
import type { ReplayContactEvent } from '~/lib/coachDomain'
import { actionColor, actionKey } from '~/utils/coachPlayerActions'
import { formatReidPair } from '~/utils/reidIdentity'

export type VolleyballOverlayMode = 'off' | 'tracking' | 'coach' | 'tactical' | 'debug'

export interface VolleyballOverlayLayers {
  bbox: boolean
  trackId: boolean
  action: boolean
  ball: boolean
  trail: boolean
  footprint: boolean
  confidence: boolean
  court: boolean
  nextHit: boolean
}

export interface OverlayTrackMetadata {
  trackId: number
  courtSide?: string | null
  label?: string | null
  gidLabel?: string | null
}

export interface OverlayRect {
  x: number
  y: number
  width: number
  height: number
}
export interface OverlayPoint {
  x: number
  y: number
}
export interface OverlayFrameBBox {
  x1: number
  y1: number
  x2: number
  y2: number
}
export type OverlayBallOverride =
  | { state: 'position'; position: OverlayPoint }
  | { state: 'missing' }

export interface VolleyballOverlayRenderInput {
  context: CanvasRenderingContext2D
  viewport: OverlayRect
  frame: number
  videoWidth: number
  videoHeight: number
  chunk?: AnalysisFrameChunk | null
  events: ReplayContactEvent[]
  actionLabels: string[]
  layers: VolleyballOverlayLayers
  mode: VolleyballOverlayMode
  tracks?: OverlayTrackMetadata[]
  teamLabels?: { left: string; right: string }
  ballCorrection?: OverlayBallOverride | null
  ballCorrections?: Record<number, OverlayBallOverride>
  actionCorrections?: Record<number, string>
  playerBBoxCorrections?: Record<number, Record<number, OverlayFrameBBox>>
  contactActorCorrections?: Record<string, number | null>
  contactTimeCorrections?: Record<string, number>
  identityLabels?: Record<number, string>
  selectedTrackId?: number | null
}

interface FrameDetection {
  sourceIndex: number
  trackId: number
  flags: number
  bbox: { x1: number; y1: number; x2: number; y2: number }
  foot: OverlayPoint
  court: OverlayPoint
  actionId: number
  confidence: number
}

const QUANTIZED_MAX = 65_535
const UNKNOWN = '#91a0b2'
const LEFT = '#22d3ee'
const RIGHT = '#fb7185'
const BALL = '#ffd34f'
// TID owns the tracking color. Keep the sequence fixed so a player does not
// change color between frames, and use enough perceptually separated colors
// that adjacent tracks on the same team remain easy to tell apart.
const TRACK_PALETTE = [
  '#7dd3fc',
  '#fda4af',
  '#fde68a',
  '#c4b5fd',
  '#86efac',
  '#fdba74',
  '#67e8f9',
  '#f9a8d4',
  '#93c5fd',
  '#bef264',
  '#f0abfc',
  '#a5b4fc',
  '#5eead4',
  '#fca5a5',
  '#d9f99d',
  '#cbd5e1',
  '#fed7aa',
  '#bae6fd',
  '#fbcfe8',
  '#bbf7d0',
] as const

// The canonical 36-point volleyball court is a 5-row grid with two sidelines.
// Keep this topology here so both the coach and annotator render the same
// projected court markings without inventing geometry in the UI.
const COURT_LINE_PATHS = [
  [4, 18, 19, 5],
  [3, 34, 35, 6],
  [2, 32, 33, 7],
  [1, 30, 31, 8],
  [0, 29, 28, 9],
  [4, 17, 16, 3, 15, 14, 2, 13, 12, 1, 11, 10, 0],
  [5, 20, 21, 6, 22, 23, 7, 24, 25, 8, 26, 27, 9],
] as const

export function resolveVideoContentRect(
  viewport: OverlayRect,
  videoWidth: number,
  videoHeight: number,
): OverlayRect {
  if (videoWidth <= 0 || videoHeight <= 0 || viewport.width <= 0 || viewport.height <= 0)
    return viewport
  const videoAspect = videoWidth / videoHeight
  const viewportAspect = viewport.width / viewport.height
  if (viewportAspect > videoAspect) {
    const width = viewport.height * videoAspect
    return {
      x: viewport.x + (viewport.width - width) / 2,
      y: viewport.y,
      width,
      height: viewport.height,
    }
  }
  const height = viewport.width / videoAspect
  return {
    x: viewport.x,
    y: viewport.y + (viewport.height - height) / 2,
    width: viewport.width,
    height,
  }
}

function quantizedPoint(position: OverlayPoint, content: OverlayRect): OverlayPoint {
  return {
    x: content.x + (position.x / QUANTIZED_MAX) * content.width,
    y: content.y + (position.y / QUANTIZED_MAX) * content.height,
  }
}

function normalizedPoint(position: OverlayPoint, content: OverlayRect): OverlayPoint {
  return { x: content.x + position.x * content.width, y: content.y + position.y * content.height }
}

function framePoint(
  position: OverlayPoint,
  content: OverlayRect,
  videoWidth: number,
  videoHeight: number,
): OverlayPoint {
  return {
    x: content.x + (position.x / videoWidth) * content.width,
    y: content.y + (position.y / videoHeight) * content.height,
  }
}

function quantizedToFrame(
  position: OverlayPoint,
  videoWidth: number,
  videoHeight: number,
): OverlayPoint {
  return {
    x: (position.x / QUANTIZED_MAX) * videoWidth,
    y: (position.y / QUANTIZED_MAX) * videoHeight,
  }
}

function frameRange(chunk: AnalysisFrameChunk, frame: number) {
  const localFrame = frame - Number(chunk.startFrameIndex)
  if (localFrame < 0 || localFrame >= chunk.frameCount) return null
  return {
    localFrame,
    start: chunk.frameOffsets[localFrame]!,
    end: chunk.frameOffsets[localFrame + 1]!,
  }
}

function collectDetections(
  chunk: AnalysisFrameChunk,
  frame: number,
  videoWidth: number,
  videoHeight: number,
  corrections?: Record<number, OverlayFrameBBox>,
): FrameDetection[] {
  const range = frameRange(chunk, frame)
  if (!range) return []
  const result: FrameDetection[] = []
  for (let index = range.start; index < range.end; index += 1) {
    result.push({
      sourceIndex: index,
      trackId: chunk.trackIds[index]!,
      flags: chunk.playerFlags[index] ?? 0,
      bbox:
        corrections?.[chunk.trackIds[index]!] ??
        (() => {
          const raw = chunk.frameBboxes[index]!
          const topLeft = quantizedToFrame({ x: raw.x1, y: raw.y1 }, videoWidth, videoHeight)
          const bottomRight = quantizedToFrame({ x: raw.x2, y: raw.y2 }, videoWidth, videoHeight)
          return { x1: topLeft.x, y1: topLeft.y, x2: bottomRight.x, y2: bottomRight.y }
        })(),
      foot: chunk.frameFootPositions[index]!,
      court: chunk.courtPositions[index]!,
      actionId: chunk.actionLabelIds[index] ?? ANALYSIS_MISSING_ACTION_LABEL,
      confidence: chunk.playerConfidences[index] ?? ANALYSIS_MISSING_CONFIDENCE,
    })
  }
  return result
}

function sideColor(side?: string | null) {
  return side === 'left' ? LEFT : side === 'right' ? RIGHT : UNKNOWN
}

export function overlayTrackIdentityLabel(
  trackId: number,
  gidLabel?: string | null,
  playerLabel?: string | null,
) {
  return [formatReidPair(trackId, gidLabel), playerLabel].filter(Boolean).join('  ')
}

export function trackColor(trackId: number) {
  const normalizedTrackId = Number.isFinite(trackId) ? Math.max(0, Math.floor(trackId)) : 0
  return TRACK_PALETTE[
    (normalizedTrackId === 0 ? 0 : normalizedTrackId - 1) % TRACK_PALETTE.length
  ]!
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath()
  context.roundRect(x, y, width, height, Math.min(radius, height / 2, width / 2))
}

function drawCornerBox(
  context: CanvasRenderingContext2D,
  topLeft: OverlayPoint,
  bottomRight: OverlayPoint,
  color: string,
) {
  const width = Math.max(1, bottomRight.x - topLeft.x)
  const height = Math.max(1, bottomRight.y - topLeft.y)
  const corner = Math.min(15, width * 0.22, height * 0.16)
  context.fillStyle = `${color}12`
  context.fillRect(topLeft.x, topLeft.y, width, height)
  context.strokeStyle = `${color}42`
  context.lineWidth = 1
  context.strokeRect(topLeft.x + 0.5, topLeft.y + 0.5, width - 1, height - 1)
  context.strokeStyle = color
  context.lineWidth = 2
  context.beginPath()
  context.moveTo(topLeft.x, topLeft.y + corner)
  context.lineTo(topLeft.x, topLeft.y)
  context.lineTo(topLeft.x + corner, topLeft.y)
  context.moveTo(bottomRight.x - corner, topLeft.y)
  context.lineTo(bottomRight.x, topLeft.y)
  context.lineTo(bottomRight.x, topLeft.y + corner)
  context.moveTo(bottomRight.x, bottomRight.y - corner)
  context.lineTo(bottomRight.x, bottomRight.y)
  context.lineTo(bottomRight.x - corner, bottomRight.y)
  context.moveTo(topLeft.x + corner, bottomRight.y)
  context.lineTo(topLeft.x, bottomRight.y)
  context.lineTo(topLeft.x, bottomRight.y - corner)
  context.stroke()
}

function drawSelectionBox(
  context: CanvasRenderingContext2D,
  topLeft: OverlayPoint,
  bottomRight: OverlayPoint,
) {
  context.save()
  context.strokeStyle = '#ffffff'
  context.lineWidth = 1.5
  context.setLineDash([5, 4])
  context.strokeRect(
    topLeft.x - 2,
    topLeft.y - 2,
    bottomRight.x - topLeft.x + 4,
    bottomRight.y - topLeft.y + 4,
  )
  context.setLineDash([])
  for (const point of [
    topLeft,
    { x: bottomRight.x, y: topLeft.y },
    bottomRight,
    { x: topLeft.x, y: bottomRight.y },
  ]) {
    context.fillStyle = '#0b0d10'
    context.fillRect(point.x - 3, point.y - 3, 6, 6)
    context.strokeStyle = '#ffffff'
    context.strokeRect(point.x - 3, point.y - 3, 6, 6)
  }
  context.restore()
}

function drawPlayerLabel(
  context: CanvasRenderingContext2D,
  detection: FrameDetection,
  topLeft: OverlayPoint,
  bottomRight: OverlayPoint,
  color: string,
  input: VolleyballOverlayRenderInput,
  track?: OverlayTrackMetadata,
) {
  const identity = input.identityLabels?.[detection.trackId]
  const team =
    track?.courtSide === 'left'
      ? input.teamLabels?.left
      : track?.courtSide === 'right'
        ? input.teamLabels?.right
        : null
  const correctedAction = input.actionCorrections?.[detection.trackId]
  const action =
    correctedAction ??
    (detection.actionId === ANALYSIS_MISSING_ACTION_LABEL
      ? null
      : (input.actionLabels[detection.actionId] ?? null))
  const primary = input.layers.trackId
    ? overlayTrackIdentityLabel(detection.trackId, track?.gidLabel, identity)
    : (identity ?? '')
  const confidence =
    input.layers.confidence && detection.confidence !== ANALYSIS_MISSING_CONFIDENCE
      ? `${Math.round((detection.confidence / 254) * 100)}%`
      : ''
  if (!primary && !team && !(input.layers.action && action) && !confidence) return
  const teamColor = sideColor(track?.courtSide)
  context.font = '800 8px Inter, ui-sans-serif, system-ui, sans-serif'
  const teamText = team ?? ''
  const teamWidth = teamText ? Math.ceil(context.measureText(teamText).width) + 10 : 0
  context.font = '750 9px Inter, ui-sans-serif, system-ui, sans-serif'
  const identityText = [primary, confidence].filter(Boolean).join('  ')
  const identityWidth = identityText ? Math.ceil(context.measureText(identityText).width) + 11 : 0
  const badgeWidth = Math.max(24, teamWidth + identityWidth)
  if (teamText || identityText) {
    const below = bottomRight.y + 4
    const badgeY =
      below + 16 <= input.viewport.y + input.viewport.height ? below : bottomRight.y - 19
    const badgeX = Math.max(
      input.viewport.x + 3,
      Math.min(
        (topLeft.x + bottomRight.x - badgeWidth) / 2,
        input.viewport.x + input.viewport.width - badgeWidth - 3,
      ),
    )
    roundedRect(context, badgeX, badgeY, badgeWidth, 16, 4)
    context.fillStyle = 'rgba(7, 11, 16, .78)'
    context.fill()
    context.strokeStyle = 'rgba(255,255,255,.12)'
    context.lineWidth = 1
    context.stroke()
    context.fillStyle = teamColor
    context.fillRect(badgeX, badgeY, 2.5, 16)
    let cursorX = badgeX + 7
    if (teamText) {
      context.font = '800 8px Inter, ui-sans-serif, system-ui, sans-serif'
      context.fillStyle = teamColor
      context.fillText(teamText, cursorX, badgeY + 11)
      cursorX += teamWidth - 3
      context.fillStyle = 'rgba(255,255,255,.22)'
      context.fillRect(cursorX - 3, badgeY + 4, 1, 8)
    }
    if (identityText) {
      context.font = '750 9px Inter, ui-sans-serif, system-ui, sans-serif'
      context.fillStyle = '#f8fafc'
      context.fillText(identityText, cursorX, badgeY + 11.3)
    }
  }
  if (input.layers.action && action) {
    const actionTone = actionColor(actionKey(action))
    const text = action.replaceAll('_', ' ').toUpperCase()
    context.font = '800 8px Inter, ui-sans-serif, system-ui, sans-serif'
    const width = Math.ceil(context.measureText(text).width) + 12
    const actionY = Math.max(input.viewport.y + 4, topLeft.y - 17)
    const actionX = Math.max(
      input.viewport.x + 3,
      Math.min(
        (topLeft.x + bottomRight.x - width) / 2,
        input.viewport.x + input.viewport.width - width - 3,
      ),
    )
    roundedRect(context, actionX, actionY, width, 14, 4)
    context.fillStyle = 'rgba(7, 11, 16, .7)'
    context.fill()
    context.strokeStyle = `${actionTone}cc`
    context.lineWidth = 1
    context.stroke()
    context.fillStyle = actionTone
    context.fillText(text, actionX + 6, actionY + 9.8)
  }
}

function drawCourtKeypoints(
  context: CanvasRenderingContext2D,
  input: VolleyballOverlayRenderInput,
  chunk: AnalysisFrameChunk,
  localFrame: number,
  content: OverlayRect,
) {
  const start = chunk.courtKeypointFrameOffsets[localFrame] ?? 0
  const end = chunk.courtKeypointFrameOffsets[localFrame + 1] ?? start
  if (end <= start) return
  const points = new Map<number, OverlayPoint>()
  for (let index = start; index < end; index += 1) {
    const confidence = chunk.courtKeypointConfidences[index] ?? ANALYSIS_MISSING_CONFIDENCE
    if (confidence !== ANALYSIS_MISSING_CONFIDENCE && confidence < 64) continue
    const position = chunk.courtKeypointPositions[index]
    if (!position) continue
    points.set(chunk.courtKeypointIds[index] ?? index - start, quantizedPoint(position, content))
  }
  if (!points.size) return
  context.save()
  context.globalAlpha = 0.38
  context.strokeStyle = '#d7e8f4'
  context.lineCap = 'round'
  context.lineJoin = 'round'
  for (const path of COURT_LINE_PATHS) {
    let drawing = false
    for (const id of path) {
      const point = points.get(id)
      if (!point) {
        if (drawing) {
          context.stroke()
          drawing = false
        }
        continue
      }
      if (!drawing) {
        context.beginPath()
        context.moveTo(point.x, point.y)
        drawing = true
      } else context.lineTo(point.x, point.y)
    }
    if (drawing) context.stroke()
  }
  for (const point of points.values()) {
    context.globalAlpha = 0.58
    context.beginPath()
    context.arc(point.x, point.y, 1.9, 0, Math.PI * 2)
    context.fillStyle = '#d7e8f4'
    context.fill()
    context.globalAlpha = 0.36
    context.beginPath()
    context.arc(point.x, point.y, 3.7, 0, Math.PI * 2)
    context.strokeStyle = '#173244'
    context.lineWidth = 1
    context.stroke()
  }
  context.restore()
}

function drawBallTrail(
  context: CanvasRenderingContext2D,
  input: VolleyballOverlayRenderInput,
  chunk: AnalysisFrameChunk,
  localFrame: number,
  content: OverlayRect,
) {
  const points: OverlayPoint[] = []
  for (let frame = Math.max(0, localFrame - 18); frame <= localFrame; frame += 1) {
    const absoluteFrame = Number(chunk.startFrameIndex) + frame
    const correction = input.ballCorrections?.[absoluteFrame]
    if (correction?.state === 'position') {
      points.push(framePoint(correction.position, content, input.videoWidth, input.videoHeight))
      continue
    }
    if (
      correction?.state === 'missing' ||
      !((chunk.ballFlags[frame] ?? 0) & ANALYSIS_BALL_FLAG.framePosition)
    )
      continue
    const position = chunk.ballFramePositions[frame]
    if (position) points.push(quantizedPoint(position, content))
  }
  if (points.length < 2) return
  context.lineCap = 'round'
  for (let index = 1; index < points.length; index += 1) {
    const opacity = 0.08 + (0.6 * index) / points.length
    context.beginPath()
    context.moveTo(points[index - 1]!.x, points[index - 1]!.y)
    context.lineTo(points[index]!.x, points[index]!.y)
    context.strokeStyle = `rgba(255, 211, 79, ${opacity})`
    context.lineWidth = 1 + (3 * index) / points.length
    context.stroke()
  }
}

function drawBallMarker(
  context: CanvasRenderingContext2D,
  position: OverlayPoint,
  corrected = false,
) {
  context.save()
  context.shadowColor = 'rgba(0, 0, 0, .55)'
  context.shadowBlur = 8
  context.beginPath()
  context.arc(position.x, position.y, corrected ? 9 : 8, 0, Math.PI * 2)
  context.fillStyle = 'rgba(12, 16, 22, .72)'
  context.fill()
  context.shadowBlur = 0
  context.beginPath()
  context.arc(position.x, position.y, corrected ? 6 : 5.5, 0, Math.PI * 2)
  context.fillStyle = 'rgba(255, 211, 79, .16)'
  context.fill()
  context.strokeStyle = corrected ? '#fff3b0' : BALL
  context.lineWidth = 2.5
  context.stroke()
  context.beginPath()
  context.arc(position.x - 1.8, position.y - 2, 1.4, 0, Math.PI * 2)
  context.fillStyle = '#fff7cc'
  context.fill()
  context.restore()
}

export function replayEventFrame(event: ReplayContactEvent, corrections?: Record<string, number>) {
  return (
    corrections?.[event.key_point_id] ??
    Number(BigInt(event.resolved_frame_index ?? event.anchor_frame_index))
  )
}

function rawBallAtFrame(input: VolleyballOverlayRenderInput, frame: number) {
  const chunk = input.chunk
  if (!chunk) return null
  const range = frameRange(chunk, frame)
  if (!range || !((chunk.ballFlags[range.localFrame] ?? 0) & ANALYSIS_BALL_FLAG.framePosition))
    return null
  const position = chunk.ballFramePositions[range.localFrame]
  return position ? quantizedToFrame(position, input.videoWidth, input.videoHeight) : null
}

export function resolveEffectiveHitPosition(
  input: Pick<
    VolleyballOverlayRenderInput,
    'ballCorrections' | 'chunk' | 'contactTimeCorrections' | 'videoHeight' | 'videoWidth'
  >,
  event: ReplayContactEvent,
) {
  const targetFrame = replayEventFrame(event, input.contactTimeCorrections)
  const exactOverride = input.ballCorrections?.[targetFrame]
  if (exactOverride?.state === 'position') return exactOverride.position
  if (!exactOverride) {
    const raw = rawBallAtFrame(input as VolleyballOverlayRenderInput, targetFrame)
    if (raw) return raw
    if (event.ball.frame_pos)
      return {
        x: event.ball.frame_pos.x * input.videoWidth,
        y: event.ball.frame_pos.y * input.videoHeight,
      }
  }

  let latestFrame = -1
  let latest: OverlayPoint | null = null
  for (const [frameText, override] of Object.entries(input.ballCorrections ?? {})) {
    const frame = Number(frameText)
    if (frame >= targetFrame || frame <= latestFrame || override.state !== 'position') continue
    latestFrame = frame
    latest = override.position
  }
  const chunk = input.chunk
  if (chunk) {
    const start = Number(chunk.startFrameIndex)
    for (let frame = targetFrame - 1; frame >= start && frame > latestFrame; frame -= 1) {
      const override = input.ballCorrections?.[frame]
      if (override?.state === 'position') return override.position
      if (override?.state === 'missing') continue
      const raw = rawBallAtFrame(input as VolleyballOverlayRenderInput, frame)
      if (raw) return raw
    }
  }
  return latest
}

function contactPoint(bbox: OverlayFrameBBox) {
  return { x: (bbox.x1 + bbox.x2) / 2, y: bbox.y1 + (bbox.y2 - bbox.y1) * 0.34 }
}

function nearestTrack(position: OverlayPoint, detections: FrameDetection[]) {
  let best: { trackId: number; distance: number } | null = null
  for (const detection of detections) {
    if (!(detection.flags & ANALYSIS_PLAYER_FLAG.frameBBox)) continue
    const point = contactPoint(detection.bbox)
    const distance = Math.hypot(position.x - point.x, position.y - point.y)
    if (!best || distance < best.distance) best = { trackId: detection.trackId, distance }
  }
  return best?.trackId ?? null
}

export function resolveEventActorFromResult(
  event: ReplayContactEvent,
  position: OverlayPoint | null,
  videoWidth: number,
  videoHeight: number,
) {
  if (position) {
    let best: { trackId: number; distance: number } | null = null
    for (const actor of event.actors) {
      if (!actor.frame_bbox) continue
      const point = contactPoint({
        x1: actor.frame_bbox.x1 * videoWidth,
        y1: actor.frame_bbox.y1 * videoHeight,
        x2: actor.frame_bbox.x2 * videoWidth,
        y2: actor.frame_bbox.y2 * videoHeight,
      })
      const distance = Math.hypot(position.x - point.x, position.y - point.y)
      if (!best || distance < best.distance) best = { trackId: actor.track_id, distance }
    }
    if (best) return best.trackId
  }
  return (event.actors[0] ?? event.candidates[0])?.track_id ?? null
}

export function resolveEffectiveContactActor(
  input: Pick<
    VolleyballOverlayRenderInput,
    | 'ballCorrections'
    | 'chunk'
    | 'contactActorCorrections'
    | 'contactTimeCorrections'
    | 'playerBBoxCorrections'
    | 'videoHeight'
    | 'videoWidth'
  >,
  event: ReplayContactEvent,
) {
  if (Object.prototype.hasOwnProperty.call(input.contactActorCorrections ?? {}, event.key_point_id))
    return input.contactActorCorrections?.[event.key_point_id] ?? null
  const position = resolveEffectiveHitPosition(input, event)
  if (position && input.chunk) {
    const frame = replayEventFrame(event, input.contactTimeCorrections)
    const detections = collectDetections(
      input.chunk,
      frame,
      input.videoWidth,
      input.videoHeight,
      input.playerBBoxCorrections?.[frame],
    )
    const trackId = nearestTrack(position, detections)
    if (trackId !== null) return trackId
  }
  return resolveEventActorFromResult(event, position, input.videoWidth, input.videoHeight)
}

function drawNextHit(
  context: CanvasRenderingContext2D,
  input: VolleyballOverlayRenderInput,
  content: OverlayRect,
) {
  const event = input.events.find(
    candidate =>
      replayEventFrame(candidate, input.contactTimeCorrections) >= input.frame &&
      replayEventFrame(candidate, input.contactTimeCorrections) - input.frame <= 40,
  )
  if (!event) return
  const position = resolveEffectiveHitPosition(input, event)
  if (!position) return
  const target = framePoint(position, content, input.videoWidth, input.videoHeight)
  const targetTrackId = resolveEffectiveContactActor(input, event)
  const remaining = Math.max(0, replayEventFrame(event, input.contactTimeCorrections) - input.frame)
  const radius = 15 + Math.min(1, remaining / 30) * 23
  const color = targetTrackId == null ? UNKNOWN : trackColor(targetTrackId)
  context.save()
  context.strokeStyle = BALL
  context.lineWidth = 3
  context.setLineDash([Math.max(5, radius * 0.35), Math.max(3, radius * 0.18)])
  context.lineDashOffset = remaining * 0.65
  context.beginPath()
  context.arc(target.x, target.y, radius, 0, Math.PI * 2)
  context.stroke()
  context.setLineDash([])
  context.strokeStyle = `${color}aa`
  context.lineWidth = 1.5
  context.beginPath()
  context.arc(target.x, target.y, Math.max(10, radius - 6), 0, Math.PI * 2)
  context.stroke()
  const label = remaining <= 1 ? 'HIT' : 'NEXT HIT'
  context.font = '750 10px Inter, ui-sans-serif, system-ui, sans-serif'
  const width = context.measureText(label).width + 14
  roundedRect(context, target.x + radius + 7, target.y - 10, width, 20, 5)
  context.fillStyle = remaining <= 1 ? BALL : 'rgba(10, 14, 20, .84)'
  context.fill()
  context.fillStyle = remaining <= 1 ? '#171006' : '#fff5c2'
  context.fillText(label, target.x + radius + 14, target.y + 3.5)
  context.restore()
}

function drawCourtRadar(
  context: CanvasRenderingContext2D,
  input: VolleyballOverlayRenderInput,
  detections: FrameDetection[],
) {
  const players = detections.filter(
    item =>
      item.flags & ANALYSIS_PLAYER_FLAG.courtPosition &&
      Number.isFinite(item.court.x) &&
      Number.isFinite(item.court.y),
  )
  if (!players.length) return
  const width = Math.max(116, Math.min(176, input.viewport.width * 0.2))
  const height = width / 2
  const x = input.viewport.x + input.viewport.width - width - 12
  const y = input.viewport.y + 12
  context.save()
  roundedRect(context, x, y, width, height, 9)
  context.fillStyle = 'rgba(7, 11, 16, .76)'
  context.fill()
  context.strokeStyle = 'rgba(255, 255, 255, .22)'
  context.lineWidth = 1
  context.stroke()
  const pad = 10
  const court = { x: x + pad, y: y + pad, width: width - pad * 2, height: height - pad * 2 }
  context.strokeStyle = 'rgba(255, 255, 255, .68)'
  context.lineWidth = 1
  context.strokeRect(court.x, court.y, court.width, court.height)
  context.beginPath()
  context.moveTo(court.x + court.width / 2, court.y)
  context.lineTo(court.x + court.width / 2, court.y + court.height)
  context.stroke()
  context.setLineDash([3, 3])
  context.strokeStyle = 'rgba(255, 255, 255, .28)'
  context.beginPath()
  context.moveTo(court.x + court.width / 3, court.y)
  context.lineTo(court.x + court.width / 3, court.y + court.height)
  context.moveTo(court.x + (court.width * 2) / 3, court.y)
  context.lineTo(court.x + (court.width * 2) / 3, court.y + court.height)
  context.stroke()
  context.setLineDash([])
  for (const player of players) {
    const px = court.x + Math.max(0, Math.min(1, player.court.x)) * court.width
    const py = court.y + Math.max(0, Math.min(1, player.court.y)) * court.height
    const color = trackColor(player.trackId)
    context.beginPath()
    context.arc(px, py, 3.5, 0, Math.PI * 2)
    context.fillStyle = color
    context.fill()
    context.strokeStyle = '#0a0e14'
    context.lineWidth = 1.5
    context.stroke()
  }
  if (input.teamLabels) {
    context.font = '650 8px Inter, ui-sans-serif, system-ui, sans-serif'
    context.fillStyle = LEFT
    context.fillText(input.teamLabels.left, court.x, y + height - 2)
    const rightWidth = context.measureText(input.teamLabels.right).width
    context.fillStyle = RIGHT
    context.fillText(input.teamLabels.right, court.x + court.width - rightWidth, y + height - 2)
  }
  context.restore()
}

function drawEventFallback(
  context: CanvasRenderingContext2D,
  input: VolleyballOverlayRenderInput,
  content: OverlayRect,
) {
  const event = input.events.reduce<ReplayContactEvent | null>((nearest, candidate) => {
    const distance = Math.abs(
      replayEventFrame(candidate, input.contactTimeCorrections) - input.frame,
    )
    if (distance > 2) return nearest
    return !nearest ||
      distance < Math.abs(replayEventFrame(nearest, input.contactTimeCorrections) - input.frame)
      ? candidate
      : nearest
  }, null)
  if (!event) return
  for (const actor of event.actors) {
    if (!actor.frame_bbox || !input.layers.bbox) continue
    const topLeft = normalizedPoint({ x: actor.frame_bbox.x1, y: actor.frame_bbox.y1 }, content)
    const bottomRight = normalizedPoint({ x: actor.frame_bbox.x2, y: actor.frame_bbox.y2 }, content)
    drawCornerBox(context, topLeft, bottomRight, UNKNOWN)
  }
  if (input.layers.ball) {
    if (input.ballCorrection?.state === 'position')
      drawBallMarker(
        context,
        framePoint(input.ballCorrection.position, content, input.videoWidth, input.videoHeight),
        true,
      )
    else if (input.ballCorrection?.state !== 'missing' && event.ball.frame_pos)
      drawBallMarker(context, normalizedPoint(event.ball.frame_pos, content))
  }
}

export function renderVolleyballOverlay(input: VolleyballOverlayRenderInput) {
  const { context, chunk, layers } = input
  const content = resolveVideoContentRect(input.viewport, input.videoWidth, input.videoHeight)
  const metadata = new Map((input.tracks ?? []).map(track => [track.trackId, track]))
  const detections = chunk
    ? collectDetections(
        chunk,
        input.frame,
        input.videoWidth,
        input.videoHeight,
        input.playerBBoxCorrections?.[input.frame],
      )
    : []
  const range = chunk ? frameRange(chunk, input.frame) : null
  if (!chunk || !range) drawEventFallback(context, input, content)
  else {
    if (layers.court) drawCourtKeypoints(context, input, chunk, range.localFrame, content)
    for (const detection of detections) {
      const track = metadata.get(detection.trackId)
      const color = trackColor(detection.trackId)
      if (detection.flags & ANALYSIS_PLAYER_FLAG.frameBBox) {
        const topLeft = framePoint(
          { x: detection.bbox.x1, y: detection.bbox.y1 },
          content,
          input.videoWidth,
          input.videoHeight,
        )
        const bottomRight = framePoint(
          { x: detection.bbox.x2, y: detection.bbox.y2 },
          content,
          input.videoWidth,
          input.videoHeight,
        )
        if (layers.bbox) drawCornerBox(context, topLeft, bottomRight, color)
        if (input.selectedTrackId === detection.trackId)
          drawSelectionBox(context, topLeft, bottomRight)
        drawPlayerLabel(context, detection, topLeft, bottomRight, color, input, track)
      }
      if (layers.footprint && detection.flags & ANALYSIS_PLAYER_FLAG.frameFootPosition) {
        const correctedBBox = input.playerBBoxCorrections?.[input.frame]?.[detection.trackId]
        const foot = correctedBBox
          ? framePoint(
              { x: (correctedBBox.x1 + correctedBBox.x2) / 2, y: correctedBBox.y2 },
              content,
              input.videoWidth,
              input.videoHeight,
            )
          : quantizedPoint(detection.foot, content)
        context.beginPath()
        context.ellipse(foot.x, foot.y, 9, 3.5, 0, 0, Math.PI * 2)
        context.fillStyle = `${color}55`
        context.fill()
        context.strokeStyle = color
        context.lineWidth = 1
        context.stroke()
      }
    }
    if (layers.trail) drawBallTrail(context, input, chunk, range.localFrame, content)
    if (layers.ball) {
      if (input.ballCorrection?.state === 'position')
        drawBallMarker(
          context,
          framePoint(input.ballCorrection.position, content, input.videoWidth, input.videoHeight),
          true,
        )
      else if (
        input.ballCorrection?.state !== 'missing' &&
        (chunk.ballFlags[range.localFrame] ?? 0) & ANALYSIS_BALL_FLAG.framePosition
      ) {
        const ball = chunk.ballFramePositions[range.localFrame]
        if (ball) drawBallMarker(context, quantizedPoint(ball, content))
      }
    }
  }
  if (layers.nextHit) drawNextHit(context, input, content)
  if (layers.court) drawCourtRadar(context, input, detections)
}

export function hitTestOverlayTrack(
  input: Pick<
    VolleyballOverlayRenderInput,
    'chunk' | 'frame' | 'videoWidth' | 'videoHeight' | 'viewport' | 'playerBBoxCorrections'
  >,
  point: OverlayPoint,
) {
  if (!input.chunk) return null
  const content = resolveVideoContentRect(input.viewport, input.videoWidth, input.videoHeight)
  if (
    point.x < content.x ||
    point.x > content.x + content.width ||
    point.y < content.y ||
    point.y > content.y + content.height
  )
    return null
  const detections = collectDetections(
    input.chunk,
    input.frame,
    input.videoWidth,
    input.videoHeight,
    input.playerBBoxCorrections?.[input.frame],
  )
  for (let index = detections.length - 1; index >= 0; index -= 1) {
    const detection = detections[index]!
    if (!(detection.flags & ANALYSIS_PLAYER_FLAG.frameBBox)) continue
    const topLeft = framePoint(
      { x: detection.bbox.x1, y: detection.bbox.y1 },
      content,
      input.videoWidth,
      input.videoHeight,
    )
    const bottomRight = framePoint(
      { x: detection.bbox.x2, y: detection.bbox.y2 },
      content,
      input.videoWidth,
      input.videoHeight,
    )
    if (
      point.x >= topLeft.x &&
      point.x <= bottomRight.x &&
      point.y >= topLeft.y &&
      point.y <= bottomRight.y
    )
      return detection
  }
  return null
}

export function overlayCanvasPointToVideo(
  point: OverlayPoint,
  viewport: OverlayRect,
  videoWidth: number,
  videoHeight: number,
) {
  const content = resolveVideoContentRect(viewport, videoWidth, videoHeight)
  if (
    point.x < content.x ||
    point.x > content.x + content.width ||
    point.y < content.y ||
    point.y > content.y + content.height
  )
    return null
  return {
    x: ((point.x - content.x) / content.width) * videoWidth,
    y: ((point.y - content.y) / content.height) * videoHeight,
  }
}
