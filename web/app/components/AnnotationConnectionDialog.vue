<script setup lang="ts">
import { Activity, RadioTower, RefreshCw, Server, TriangleAlert, UsersRound } from 'lucide-vue-next'
import UiButton from '~/components/ui/Button.vue'
import type { CaptureSession } from '~/lib/coreDomain'
import type { PlaybackWindowDescriptor } from '~/lib/mediaModel'

defineProps<{
  open: boolean
  connection: string
  capture: CaptureSession | null
  descriptor: PlaybackWindowDescriptor | null
  pending: number
  editors: number
  needsAttention: boolean
  hasConflicts: boolean
  resyncing: boolean
}>()
defineEmits<{ close: []; resync: [] }>()
const label = (value: string) =>
  value.toLowerCase() === 'ready' ||
  value.toLowerCase() === 'live' ||
  value.toLowerCase() === 'healthy'
    ? '正常'
    : value.toLowerCase() === 'connecting' || value.toLowerCase() === 'starting'
      ? '連線中'
      : '需注意'
</script>

<template>
  <UiAnimatedModal
    :open="open"
    title="連線資訊"
    description="目前工作站與媒體狀態"
    width="compact"
    @close="$emit('close')"
  >
    <div class="connection-grid">
      <article>
        <Activity :size="16" />
        <div>
          <span>標註連線</span><strong>{{ label(connection) }}</strong>
        </div>
        <i :class="{ ready: connection === 'ready' }" />
      </article>
      <article>
        <RadioTower :size="16" />
        <div>
          <span>影音來源</span><strong>{{ capture?.sourceLabel || '尚未設定' }}</strong
          ><small>{{
            capture ? `${label(capture.status)} · ${label(capture.health)}` : '—'
          }}</small>
        </div>
        <i :class="{ ready: capture?.health.toLowerCase() === 'healthy' }" />
      </article>
      <article>
        <Server :size="16" />
        <div>
          <span>播放視窗</span
          ><strong>{{
            descriptor ? (descriptor.mode === 'live' ? 'LIVE' : '回放') : '準備中'
          }}</strong
          ><small>{{ descriptor?.playback_window_id.slice(0, 8) || '—' }}</small>
        </div>
        <i :class="{ ready: descriptor }" />
      </article>
      <article>
        <UsersRound :size="16" />
        <div>
          <span>協作者</span><strong>{{ editors }} 人</strong
          ><small>{{ pending ? `${pending} 個操作同步中` : '操作已同步' }}</small>
        </div>
        <i :class="{ ready: !pending }" />
      </article>
      <p v-if="needsAttention" class="sync-warning" role="status">
        <TriangleAlert :size="15" /><span>{{
          hasConflicts
            ? '有一筆本機操作與最新狀態衝突。重新同步會捨棄尚未確認的操作，再取得伺服器最新狀態。'
            : '標註連線或狀態需要更新，可立即重新連線並取得最新片段。'
        }}</span>
      </p>
    </div>
    <template #footer>
      <UiButton variant="ghost" @click="$emit('close')">關閉</UiButton>
      <UiButton v-if="needsAttention" :disabled="resyncing" @click="$emit('resync')"
        ><RefreshCw :size="14" :class="{ spinning: resyncing }" />{{
          resyncing ? '同步中' : '重新同步'
        }}</UiButton
      >
    </template>
  </UiAnimatedModal>
</template>

<style scoped>
.connection-grid {
  display: grid;
  padding: 10px 16px 14px;
  background: #09090b;
}
.connection-grid article {
  min-height: 64px;
  display: grid;
  grid-template-columns: 28px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 10px 2px;
  border-bottom: 1px solid #27272a;
}
.connection-grid article > svg {
  color: #71717a;
}
.connection-grid article > div {
  display: grid;
  gap: 2px;
}
.connection-grid span,
.connection-grid small {
  color: #a1a1aa;
  font-size: 0.62rem;
}
.connection-grid strong {
  font-size: 0.73rem;
}
.connection-grid i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #d4a72c;
}
.connection-grid i.ready {
  background: #22c55e;
}
.sync-warning {
  display: grid;
  grid-template-columns: 20px 1fr;
  gap: 7px;
  margin: 10px 0 0;
  padding: 10px;
  border: 1px solid #745925;
  border-radius: 8px;
  background: #2b2212;
  color: #f5cf82;
  font-size: 0.66rem;
  line-height: 1.5;
}
.sync-warning svg {
  margin-top: 1px;
}
.sync-warning span {
  color: inherit;
}
.spinning {
  animation: spin 0.85s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinning {
    animation: none;
  }
}
</style>
