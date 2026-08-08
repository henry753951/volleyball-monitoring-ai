<script setup lang="ts">
import { Home, RadioTower, Settings, UsersRound, Wifi } from 'lucide-vue-next'

defineProps<{
  title: string
  syncLabel: string
  busy: boolean
  error: boolean
  connectionTitle: string
}>()

defineEmits<{
  media: []
  connection: []
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
      <button type="button" :title="connectionTitle" @click="$emit('connection')"><Wifi :size="13" />連線資訊</button>
      <button type="button" @click="$emit('roster')"><UsersRound :size="13" />球員編輯</button>
    </nav>
    <div class="session-status"><i class="status-dot" :class="{ busy, error }" /><span>{{ syncLabel }}</span></div>
    <div class="app-actions"><button type="button" aria-label="設定" title="設定" @click="$emit('settings')"><Settings :size="16" /></button></div>
  </header>
</template>

<style scoped>
.app-bar{min-width:0;display:grid;grid-template-columns:auto minmax(280px,1fr) auto minmax(220px,auto);align-items:center;gap:12px;padding:0 10px;border-bottom:1px solid var(--line);background:#09090b;color:#f4f4f5}.window-title{min-width:0;display:flex;align-items:center;gap:7px}.window-title strong{max-width:260px;overflow:hidden;font-size:.75rem;text-overflow:ellipsis;white-space:nowrap}.window-home{width:29px;min-height:29px;display:grid;place-items:center;padding:0;border:0;border-radius:8px;background:transparent;color:#d4d4d8;text-decoration:none}.window-home:hover{background:#232a31;color:#fff}.window-menu{display:flex;align-items:center;gap:2px}.window-menu button{min-height:27px;display:flex;align-items:center;gap:5px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:#9da6af;font-size:.65rem;cursor:pointer}.window-menu button:hover{background:#20262c;color:#eef2f5}.session-status{min-width:0;display:flex;justify-content:flex-start;align-items:center;gap:8px;color:#c4ccd4;font-size:.68rem}.status-dot{width:7px;height:7px;border-radius:50%;background:var(--green)}.status-dot.busy{background:var(--amber)}.status-dot.error{background:var(--red)}.app-actions{min-width:32px;display:flex;justify-content:flex-end}.app-actions button{width:30px;min-height:30px;display:grid;place-items:center;padding:0;border:0;border-radius:7px;background:transparent;color:inherit;cursor:pointer}.app-actions button:hover{background:#27272a}@media(max-width:1050px){.app-bar{grid-template-columns:auto 1fr auto}.window-menu{display:none}}
</style>
