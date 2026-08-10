<script setup lang="ts">
import type { TeamSetupInput } from '../lib/coreDomain'
import UiButton from '~/components/ui/Button.vue'
import UiSelect from '~/components/ui/Select.vue'
import { ROSTER_POSITION_SELECT_OPTIONS } from '~/lib/rosterPositions'

defineProps<{ label: string }>()
const team = defineModel<TeamSetupInput>({ required: true })
defineEmits<{ add: []; remove: [index: number] }>()
</script>

<template>
  <section class="team-setup">
    <header><strong>{{ label }}</strong><span>{{ team.roster.length }} 人</span></header>
    <div class="team-setup__names"><label><span class="field-label">隊名</span><input v-model="team.name" class="field" required maxlength="100" autocomplete="organization" /></label><label><span class="field-label">簡稱</span><input v-model="team.shortName" class="field" required maxlength="24" autocomplete="off" /></label></div>
    <div class="team-setup__roster"><div><h3>球員名單 <span>（選填）</span></h3><UiButton variant="ghost" size="sm" @click="$emit('add')">＋ 新增</UiButton></div><p v-if="team.roster.length === 0" class="team-setup__empty">可先建立場次，之後再從球員編輯補上名單。</p><div v-for="(row, index) in team.roster" :key="index" class="team-setup__row"><input v-model="row.name" class="field" placeholder="姓名" maxlength="80" autocomplete="name" /><input v-model="row.jerseyNumber" class="field" placeholder="背號" maxlength="3" inputmode="numeric" pattern="[0-9]+" autocomplete="off" /><UiSelect v-model="row.position" :options="ROSTER_POSITION_SELECT_OPTIONS" :aria-label="`第 ${index + 1} 位球員位置`" /><UiButton variant="ghost" size="icon-sm" :aria-label="`移除第 ${index + 1} 位球員`" @click="$emit('remove', index)">×</UiButton></div></div>
  </section>
</template>

<style scoped>
.team-setup{padding:14px;border-radius:10px;background:#111113;color:#fafafa}.team-setup>header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.team-setup>header strong{font-size:.8rem}.team-setup>header span{color:#a1a1aa;font-size:.66rem}.team-setup__names{display:grid;grid-template-columns:1fr 110px;gap:9px}.team-setup__roster{margin-top:13px}.team-setup__roster>div:first-child{height:32px;display:flex;align-items:center;justify-content:space-between}.team-setup h3{margin:0;font-size:.7rem}.team-setup h3 span{color:#71717a;font-weight:500}.team-setup__empty{margin:6px 0 0;color:#71717a;font-size:.66rem;line-height:1.5}.team-setup__row{display:grid;grid-template-columns:minmax(120px,1fr) 64px minmax(132px,.72fr) 32px;gap:6px;margin-top:6px}.team-setup :deep(.field){min-height:38px;padding:7px 9px;border:1px solid #27272a;border-radius:8px;background:#18181b;color:#fafafa;font-size:.72rem}.team-setup :deep(.field:focus){border-color:#71717a;box-shadow:0 0 0 2px #fafafa24}@media(max-width:760px){.team-setup__row{grid-template-columns:minmax(0,1fr) 64px 32px}.team-setup__row :deep(.ui-select__trigger){grid-column:1/3}}@media(max-width:520px){.team-setup__names{grid-template-columns:1fr}}
</style>
