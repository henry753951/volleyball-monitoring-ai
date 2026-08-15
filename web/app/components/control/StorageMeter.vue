<script setup lang="ts">
import { Boxes, HardDrive } from 'lucide-vue-next'
import { computed } from 'vue'
import type { HostStorageSnapshot } from '~/lib/operationsMonitor'

const props = defineProps<{
  detail: string
  kind: 'object' | 'temporary'
  label: string
  storage: HostStorageSnapshot | null
}>()

const usedPercent = computed(() => {
  try {
    const total = BigInt(props.storage?.totalBytes ?? '0')
    if (total <= 0n) return 0
    return Number((BigInt(props.storage?.managedBytes ?? '0') * 10_000n) / total) / 100
  } catch {
    return 0
  }
})

function formatBytes(value: string) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  const index = Math.min(Math.floor(Math.log(amount) / Math.log(1024)), units.length - 1)
  return `${(amount / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`
}
</script>

<template>
  <section class="storage-meter" :class="[kind, { unavailable: !storage?.available }]">
    <span class="storage-icon" aria-hidden="true">
      <Boxes v-if="kind === 'object'" :size="16" />
      <HardDrive v-else :size="16" />
    </span>
    <div class="storage-copy">
      <strong>{{ label }}</strong>
      <small>{{ storage?.available ? detail : '容量監控目前無法連線' }}</small>
    </div>
    <div
      class="storage-progress"
      role="progressbar"
      :aria-label="`${label}使用率`"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="Math.round(usedPercent)"
    >
      <i :style="{ transform: `scaleX(${Math.min(100, usedPercent) / 100})` }" />
    </div>
    <div class="storage-capacity">
      <strong>{{ storage?.available ? `${formatBytes(storage.freeBytes)} 可用` : '—' }}</strong>
      <small>{{
        storage?.available
          ? `${formatBytes(storage.managedBytes)} 已使用 · ${usedPercent.toFixed(1)}%`
          : '狀態未知'
      }}</small>
    </div>
  </section>
</template>

<style scoped>
.storage-meter {
  min-height: 64px;
  display: grid;
  grid-template-columns: 32px minmax(180px, 0.65fr) minmax(180px, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
}
.storage-meter + .storage-meter {
  border-top: 1px solid #27292d;
}
.storage-icon {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: #23252a;
  color: #b7bac0;
}
.storage-meter.object .storage-icon {
  color: #65d7a2;
}
.storage-copy,
.storage-capacity {
  display: grid;
  gap: 3px;
}
.storage-copy strong,
.storage-capacity strong {
  font-size: 0.62rem;
}
.storage-copy small,
.storage-capacity small {
  color: #72757b;
  font-size: 0.51rem;
}
.storage-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.storage-capacity {
  min-width: 92px;
  text-align: right;
}
.storage-progress {
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: #292c31;
}
.storage-progress i {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  background: #aeb1b5;
  transform-origin: left;
  transition: transform 240ms ease;
}
.object .storage-progress i {
  background: #47c187;
}
.unavailable {
  opacity: 0.58;
}
@media (max-width: 760px) {
  .storage-meter {
    grid-template-columns: 32px 1fr auto;
  }
  .storage-progress {
    grid-column: 2 / 4;
  }
}
@media (prefers-reduced-motion: reduce) {
  .storage-progress i {
    transition: none;
  }
}
</style>
