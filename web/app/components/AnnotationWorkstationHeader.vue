<script setup lang="ts">
import { Home, RadioTower, RefreshCw, Settings, UsersRound } from 'lucide-vue-next'

defineProps<{
  title: string
  syncLabel: string
  latencyMs: number | null
  busy: boolean
  error: boolean
  connectionTitle: string
  resyncVisible: boolean
  resyncing: boolean
}>()

defineEmits<{
  media: []
  connection: []
  resync: []
  roster: []
  settings: []
}>()
</script>

<template>
  <header class="app-bar">
    <div class="window-title">
      <NuxtLink to="/control" class="window-home" aria-label="返回控制台" title="返回控制台"><Home :size="15" /></NuxtLink>
      <strong>{{ title }}</strong>
    </div>
    <nav class="window-menu" aria-label="場次工具">
      <button type="button" @click="$emit('media')"><RadioTower :size="13" />媒體資訊</button>
      <button type="button" @click="$emit('roster')"><UsersRound :size="13" />球員編輯</button>
    </nav>
    <div class="app-actions">
      <button type="button" class="session-status" :title="connectionTitle" @click="$emit('connection')">
        <i class="status-dot" :class="{ busy, error }" />
        <span>{{ syncLabel }}</span>
        <span class="latency">{{ latencyMs ?? '—' }} ms</span>
      </button>
      <button v-if="resyncVisible" type="button" class="resync-button" :disabled="resyncing" @click="$emit('resync')">
        <RefreshCw :size="13" :class="{ spinning: resyncing }" />
        {{ resyncing ? '同步中' : '重新同步' }}
      </button>
      <button type="button" class="settings-button" aria-label="設定" title="設定" @click="$emit('settings')"><Settings :size="16" /></button>
    </div>
  </header>
</template>

<style scoped>
.app-bar{min-width:0;display:grid;grid-template-columns:auto minmax(280px,1fr) auto;align-items:center;gap:12px;padding:0 10px;border-bottom:1px solid var(--line);background:#09090b;color:#f4f4f5}.window-title{min-width:0;display:flex;align-items:center;gap:7px}.window-title strong{max-width:260px;overflow:hidden;font-size:.75rem;text-overflow:ellipsis;white-space:nowrap}.window-home{width:29px;min-height:29px;display:grid;place-items:center;padding:0;border:0;border-radius:8px;background:transparent;color:#d4d4d8;text-decoration:none}.window-home:hover{background:#232a31;color:#fff}.window-menu{display:flex;align-items:center;gap:2px}.window-menu button{min-height:27px;display:flex;align-items:center;gap:5px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:#9da6af;font-size:.65rem;cursor:pointer}.window-menu button:hover{background:#20262c;color:#eef2f5}.app-actions{display:flex;justify-content:flex-end;align-items:center;gap:3px}.session-status{min-height:28px;display:flex;align-items:center;gap:6px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:#aeb6bf;font-size:.66rem;white-space:nowrap;cursor:pointer}.session-status:hover{background:#20262c;color:#eef2f5}.status-dot{width:7px;height:7px;flex:0 0 auto;border-radius:50%;background:var(--green)}.status-dot.busy{background:var(--amber)}.status-dot.error{background:var(--red)}.latency{min-width:38px;color:#717982;font-variant-numeric:tabular-nums;text-align:right}.session-status:hover .latency{color:#aeb6bf}.settings-button{width:30px;min-height:30px;display:grid;place-items:center;padding:0;border:0;border-radius:7px;background:transparent;color:inherit;cursor:pointer}.settings-button:hover{background:#27272a}@media(max-width:1050px){.app-bar{grid-template-columns:minmax(0,1fr) auto}.window-menu{display:none}}@media(max-width:640px){.session-status>span:first-of-type{display:none}}
.resync-button{min-height:27px;display:flex;align-items:center;gap:5px;padding:0 8px;border:1px solid #7a5c28;border-radius:6px;background:#2b2212;color:#f5cf82;font-size:.62rem;font-weight:680;white-space:nowrap;cursor:pointer}.resync-button:hover:not(:disabled){border-color:#a27a31;background:#362a14}.resync-button:disabled{opacity:.65;cursor:wait}.spinning{animation:spin .85s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:720px){.resync-button{width:28px;padding:0;justify-content:center;font-size:0}}@media(prefers-reduced-motion:reduce){.spinning{animation:none}}
</style>
