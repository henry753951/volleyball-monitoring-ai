<script setup lang="ts">
import { Wifi, WifiOff } from 'lucide-vue-next'

const { state, latencyMs } = useCoachSocket()
</script>

<template>
  <span
    class="ws-ping"
    :class="`ws-ping--${state}`"
    :title="state === 'online' ? `WebSocket ${latencyMs ?? '—'} ms` : 'WebSocket 重新連線中'"
  >
    <Wifi v-if="state === 'online'" :size="14" aria-hidden="true" />
    <WifiOff v-else :size="14" aria-hidden="true" />
    <span
      >WS
      {{
        state === 'online' ? `${latencyMs ?? '—'} ms` : state === 'connecting' ? '連線中' : '離線'
      }}</span
    >
  </span>
</template>

<style scoped>
.ws-ping {
  display: inline-flex;
  min-height: 28px;
  align-items: center;
  gap: 6px;
  padding: 0 9px;
  border-radius: 999px;
  background: rgba(118, 118, 128, 0.1);
  color: #5f6368;
  font-size: 0.7rem;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ws-ping--online {
  color: #16734a;
}
.ws-ping--offline {
  color: #b4232c;
}
@media (prefers-contrast: more) {
  .ws-ping {
    border: 1px solid currentColor;
    background: #fff;
  }
}
</style>
