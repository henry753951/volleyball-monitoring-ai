<script setup lang="ts">
import { Activity, RadioTower, Server, UsersRound } from 'lucide-vue-next'
import type { CaptureSession } from '~/lib/coreDomain'
import type { PlaybackWindowDescriptor } from '~/lib/mediaModel'

defineProps<{
  open: boolean
  connection: string
  capture: CaptureSession | null
  descriptor: PlaybackWindowDescriptor | null
  pending: number
  editors: number
}>()
defineEmits<{ close: [] }>()
const label = (value: string) => value.toLowerCase() === 'ready' || value.toLowerCase() === 'live' || value.toLowerCase() === 'healthy' ? '正常' : value.toLowerCase() === 'connecting' || value.toLowerCase() === 'starting' ? '連線中' : '需注意'
</script>

<template>
  <UiAnimatedModal :open="open" title="連線資訊" description="目前工作站與媒體狀態" width="compact" @close="$emit('close')">
    <div class="connection-grid">
      <article><Activity :size="16" /><div><span>標註連線</span><strong>{{ label(connection) }}</strong></div><i :class="{ ready: connection === 'ready' }" /></article>
      <article><RadioTower :size="16" /><div><span>影音來源</span><strong>{{ capture?.sourceLabel || '尚未設定' }}</strong><small>{{ capture ? `${label(capture.status)} · ${label(capture.health)}` : '—' }}</small></div><i :class="{ ready: capture?.health.toLowerCase() === 'healthy' }" /></article>
      <article><Server :size="16" /><div><span>播放視窗</span><strong>{{ descriptor ? (descriptor.mode === 'live' ? 'LIVE' : '回放') : '準備中' }}</strong><small>{{ descriptor?.playback_window_id.slice(0, 8) || '—' }}</small></div><i :class="{ ready: descriptor }" /></article>
      <article><UsersRound :size="16" /><div><span>協作者</span><strong>{{ editors }} 人</strong><small>{{ pending ? `${pending} 個操作同步中` : '操作已同步' }}</small></div><i :class="{ ready: !pending }" /></article>
    </div>
  </UiAnimatedModal>
</template>

<style scoped>
.connection-grid{display:grid;padding:10px 16px 14px;background:#09090b}.connection-grid article{min-height:64px;display:grid;grid-template-columns:28px 1fr auto;align-items:center;gap:8px;padding:10px 2px;border-bottom:1px solid #27272a}.connection-grid article:last-child{border-bottom:0}.connection-grid article>svg{color:#71717a}.connection-grid article>div{display:grid;gap:2px}.connection-grid span,.connection-grid small{color:#a1a1aa;font-size:.62rem}.connection-grid strong{font-size:.73rem}.connection-grid i{width:8px;height:8px;border-radius:50%;background:#d4a72c}.connection-grid i.ready{background:#22c55e}
</style>
