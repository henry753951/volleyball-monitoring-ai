<script setup lang="ts">
import type { TeamSetupInput } from '../lib/coreDomain'

defineProps<{ label: string }>()
const team = defineModel<TeamSetupInput>({ required: true })
defineEmits<{ add: []; remove: [index: number] }>()
</script>

<template>
  <section class="team-setup">
    <header><strong>{{ label }}</strong><span>{{ team.roster.length }} 人</span></header>
    <div class="team-setup__names"><label><span class="field-label">隊名</span><input v-model="team.name" class="field" required maxlength="100" autocomplete="organization" /></label><label><span class="field-label">簡稱</span><input v-model="team.shortName" class="field" required maxlength="24" autocomplete="off" /></label></div>
    <div class="team-setup__roster"><div><h3>球員名單</h3><button type="button" @click="$emit('add')">＋ 新增</button></div><div v-for="(row, index) in team.roster" :key="index" class="team-setup__row"><input v-model="row.name" class="field" placeholder="姓名" required maxlength="80" autocomplete="name" /><input v-model="row.jerseyNumber" class="field" placeholder="背號" required maxlength="3" inputmode="numeric" pattern="[0-9]+" autocomplete="off" /><button type="button" :aria-label="`移除第 ${index + 1} 位球員`" :disabled="team.roster.length === 1" @click="$emit('remove', index)">×</button></div></div>
  </section>
</template>

<style scoped>
.team-setup{padding:14px;border-radius:14px;background:#fff}.team-setup>header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.team-setup>header strong{font-size:.8rem}.team-setup>header span{color:#7a828d;font-size:.66rem}.team-setup__names{display:grid;grid-template-columns:1fr 110px;gap:9px}.team-setup__roster{margin-top:13px}.team-setup__roster>div:first-child{height:32px;display:flex;align-items:center;justify-content:space-between}.team-setup h3{margin:0;font-size:.7rem}.team-setup__roster>div:first-child button{border:0;background:transparent;color:#0a66d8;font-size:.68rem;font-weight:700}.team-setup__row{display:grid;grid-template-columns:1fr 80px 32px;gap:6px;margin-top:6px}.team-setup__row>button{border:0;border-radius:8px;background:#f0f2f5;color:#69717c}.team-setup :deep(.field){min-height:38px;border-radius:9px;padding:7px 9px;font-size:.72rem}@media(max-width:520px){.team-setup__names{grid-template-columns:1fr}}
</style>
