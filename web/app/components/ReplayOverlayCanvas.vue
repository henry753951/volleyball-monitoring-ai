<script setup lang="ts">
import type { ReplayContactEvent } from '~/lib/coachDomain'

const props = defineProps<{ events: ReplayContactEvent[]; frame: number; videoWidth: number; videoHeight: number }>()
const canvas = useTemplateRef<HTMLCanvasElement>('canvas')
let observer: ResizeObserver | null = null

function draw() {
  const element = canvas.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  const ratio = window.devicePixelRatio || 1
  element.width = Math.max(1, Math.round(rect.width * ratio))
  element.height = Math.max(1, Math.round(rect.height * ratio))
  const context = element.getContext('2d')
  if (!context) return
  context.scale(ratio, ratio)
  context.clearRect(0, 0, rect.width, rect.height)
  const event = props.events.reduce<ReplayContactEvent | null>((nearest, candidate) => {
    const frame = Number(BigInt(candidate.resolved_frame_index ?? candidate.anchor_frame_index))
    if (Math.abs(frame - props.frame) > 2) return nearest
    if (!nearest) return candidate
    return Math.abs(frame - props.frame) < Math.abs(Number(BigInt(nearest.resolved_frame_index ?? nearest.anchor_frame_index)) - props.frame) ? candidate : nearest
  }, null)
  if (!event) return
  context.lineWidth = 2
  context.font = '600 12px Inter, sans-serif'
  for (const actor of event.actors) {
    if (!actor.frame_bbox) continue
    const x = actor.frame_bbox.x1 * rect.width
    const y = actor.frame_bbox.y1 * rect.height
    const width = (actor.frame_bbox.x2 - actor.frame_bbox.x1) * rect.width
    const height = (actor.frame_bbox.y2 - actor.frame_bbox.y1) * rect.height
    context.strokeStyle = '#2dd4bf'
    context.fillStyle = 'rgba(13,148,136,.18)'
    context.fillRect(x, y, width, height)
    context.strokeRect(x, y, width, height)
    context.fillStyle = '#ffffff'
    context.fillText(`Track ${actor.track_id}`, x + 4, Math.max(14, y - 5))
  }
  if (event.ball.frame_pos) {
    const x = event.ball.frame_pos.x * rect.width
    const y = event.ball.frame_pos.y * rect.height
    context.beginPath(); context.arc(x, y, 7, 0, Math.PI * 2); context.fillStyle = '#fbbf24'; context.fill(); context.strokeStyle = '#78350f'; context.stroke()
  }
}

watch(() => [props.events, props.frame, props.videoWidth, props.videoHeight], draw, { deep: true })
onMounted(() => { observer = new ResizeObserver(draw); if (canvas.value) observer.observe(canvas.value); draw() })
onUnmounted(() => observer?.disconnect())
</script>

<template><canvas ref="canvas" class="pointer-events-none absolute inset-0 size-full" aria-hidden="true" /></template>
