<script setup lang="ts">
import {
  OVERLAY_BALL_FLAG,
  OVERLAY_MISSING_ACTION_LABEL,
  OVERLAY_MISSING_CONFIDENCE,
  OVERLAY_PLAYER_FLAG,
  type BrowserOverlayChunk,
} from '@volleyball-monitoring/contracts'
import type { ReplayContactEvent } from '~/lib/coachDomain'

export type ReplayOverlayMode = 'off' | 'tracking' | 'coach' | 'tactical' | 'debug'
export interface ReplayOverlayLayers { bbox: boolean; trackId: boolean; action: boolean; ball: boolean; trail: boolean; footprint: boolean; confidence: boolean }
const props = defineProps<{ events: ReplayContactEvent[]; frame: number; videoWidth: number; videoHeight: number; chunk?: BrowserOverlayChunk | null; actionLabels?: string[]; mode?: ReplayOverlayMode; layers?: ReplayOverlayLayers }>()
const canvas = useTemplateRef<HTMLCanvasElement>('canvas')
let observer: ResizeObserver | null = null

function contentRect(rect: DOMRect) {
  if (props.videoWidth <= 0 || props.videoHeight <= 0) return { x: 0, y: 0, width: rect.width, height: rect.height }
  const videoAspect = props.videoWidth / props.videoHeight
  const elementAspect = rect.width / rect.height
  if (elementAspect > videoAspect) { const width = rect.height * videoAspect; return { x: (rect.width - width) / 2, y: 0, width, height: rect.height } }
  const height = rect.width / videoAspect
  return { x: 0, y: (rect.height - height) / 2, width: rect.width, height }
}

function point(position: { x: number; y: number }, content: { x: number; y: number; width: number; height: number }, quantized = false) {
  const divisor = quantized ? 65_535 : 1
  return { x: content.x + position.x / divisor * content.width, y: content.y + position.y / divisor * content.height }
}

function drawChunk(context: CanvasRenderingContext2D, content: ReturnType<typeof contentRect>) {
  const chunk = props.chunk
  const layers = props.layers
  if (!chunk || !layers || props.mode === 'off') return false
  const localFrame = props.frame - Number(chunk.startFrameIndex)
  if (localFrame < 0 || localFrame >= chunk.frameCount) return false
  const start = chunk.frameOffsets[localFrame]!
  const end = chunk.frameOffsets[localFrame + 1]!
  context.lineWidth = 2
  context.font = '600 12px Inter, sans-serif'
  for (let index = start; index < end; index += 1) {
    const flags = chunk.playerFlags[index] ?? 0
    const bbox = chunk.frameBboxes[index]
    if (bbox && layers.bbox && (flags & OVERLAY_PLAYER_FLAG.frameBBox)) {
      const topLeft = point({ x: bbox.x1, y: bbox.y1 }, content, true)
      const bottomRight = point({ x: bbox.x2, y: bbox.y2 }, content, true)
      context.strokeStyle = '#2dd4bf'; context.fillStyle = 'rgba(13,148,136,.16)'
      context.fillRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y)
      context.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y)
      const labels: string[] = []
      if (layers.trackId) labels.push(`Track ${chunk.trackIds[index]}`)
      const actionId = chunk.actionLabelIds[index] ?? OVERLAY_MISSING_ACTION_LABEL
      if (layers.action && actionId !== OVERLAY_MISSING_ACTION_LABEL) labels.push(props.actionLabels?.[actionId] ?? `Action ${actionId}`)
      const confidence = chunk.playerConfidences[index] ?? OVERLAY_MISSING_CONFIDENCE
      if (layers.confidence && confidence !== OVERLAY_MISSING_CONFIDENCE) labels.push(`${Math.round(confidence / 254 * 100)}%`)
      if (labels.length) { context.fillStyle = '#fff'; context.fillText(labels.join(' · '), topLeft.x + 4, Math.max(14, topLeft.y - 5)) }
    }
    const foot = chunk.frameFootPositions[index]
    if (foot && layers.footprint && (flags & OVERLAY_PLAYER_FLAG.frameFootPosition)) {
      const mapped = point(foot, content, true)
      context.beginPath(); context.ellipse(mapped.x, mapped.y, 8, 3, 0, 0, Math.PI * 2); context.fillStyle = '#a78bfa99'; context.fill()
    }
  }
  if (layers.trail) {
    context.beginPath()
    let started = false
    for (let frame = Math.max(0, localFrame - 12); frame <= localFrame; frame += 1) {
      if (!((chunk.ballFlags[frame] ?? 0) & OVERLAY_BALL_FLAG.framePosition)) continue
      const ball = chunk.ballFramePositions[frame]
      if (!ball) continue
      const mapped = point(ball, content, true)
      started ? context.lineTo(mapped.x, mapped.y) : context.moveTo(mapped.x, mapped.y)
      started = true
    }
    if (started) { context.strokeStyle = '#fbbf2499'; context.lineWidth = 3; context.stroke() }
  }
  if (layers.ball && ((chunk.ballFlags[localFrame] ?? 0) & OVERLAY_BALL_FLAG.framePosition)) {
    const ball = chunk.ballFramePositions[localFrame]
    if (ball) { const mapped = point(ball, content, true); context.beginPath(); context.arc(mapped.x, mapped.y, 7, 0, Math.PI * 2); context.fillStyle = '#fbbf24'; context.fill(); context.strokeStyle = '#78350f'; context.stroke() }
  }
  return true
}

function drawEventFallback(context: CanvasRenderingContext2D, content: ReturnType<typeof contentRect>) {
  const layers = props.layers
  if (!layers || props.mode === 'off') return
  const event = props.events.reduce<ReplayContactEvent | null>((nearest, candidate) => {
    const frame = Number(BigInt(candidate.resolved_frame_index ?? candidate.anchor_frame_index))
    if (Math.abs(frame - props.frame) > 2) return nearest
    if (!nearest) return candidate
    return Math.abs(frame - props.frame) < Math.abs(Number(BigInt(nearest.resolved_frame_index ?? nearest.anchor_frame_index)) - props.frame) ? candidate : nearest
  }, null)
  if (!event) return
  context.lineWidth = 2; context.font = '600 12px Inter, sans-serif'
  for (const actor of event.actors) {
    if (!actor.frame_bbox || !layers.bbox) continue
    const topLeft = point({ x: actor.frame_bbox.x1, y: actor.frame_bbox.y1 }, content)
    const bottomRight = point({ x: actor.frame_bbox.x2, y: actor.frame_bbox.y2 }, content)
    context.strokeStyle = '#2dd4bf'; context.fillStyle = 'rgba(13,148,136,.18)'; context.fillRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y); context.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y)
    if (layers.trackId) { context.fillStyle = '#fff'; context.fillText(`Track ${actor.track_id}`, topLeft.x + 4, Math.max(14, topLeft.y - 5)) }
  }
  if (layers.ball && event.ball.frame_pos) { const mapped = point(event.ball.frame_pos, content); context.beginPath(); context.arc(mapped.x, mapped.y, 7, 0, Math.PI * 2); context.fillStyle = '#fbbf24'; context.fill(); context.strokeStyle = '#78350f'; context.stroke() }
}

function draw() {
  const element = canvas.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  const ratio = window.devicePixelRatio || 1
  element.width = Math.max(1, Math.round(rect.width * ratio)); element.height = Math.max(1, Math.round(rect.height * ratio))
  const context = element.getContext('2d')
  if (!context) return
  context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, rect.width, rect.height)
  const content = contentRect(rect)
  if (!drawChunk(context, content)) drawEventFallback(context, content)
}

watch(() => [props.events, props.frame, props.videoWidth, props.videoHeight, props.chunk, props.mode, props.layers, props.actionLabels], draw, { deep: true })
onMounted(() => { observer = new ResizeObserver(draw); if (canvas.value) observer.observe(canvas.value); draw() })
onUnmounted(() => observer?.disconnect())
</script>

<template><canvas ref="canvas" class="pointer-events-none absolute inset-0 size-full" aria-hidden="true" /></template>
