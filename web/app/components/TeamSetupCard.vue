<script setup lang="ts">
import type { TeamSetupInput } from '../lib/coreDomain'

defineProps<{ label: string }>()
const team = defineModel<TeamSetupInput>({ required: true })
defineEmits<{ add: []; remove: [index: number] }>()
</script>

<template>
  <section class="rounded-3xl border border-stone-200 bg-white/90 p-5 shadow-sm backdrop-blur-xl">
    <div class="flex items-center justify-between gap-3"><div><p class="text-xs font-semibold uppercase tracking-[0.18em] text-teal-700">{{ label }}</p><h2 class="mt-1 text-xl font-semibold">隊伍與名單</h2></div><span class="rounded-full bg-stone-100 px-3 py-1 text-xs text-stone-500">{{ team.roster.length }} 位球員</span></div>
    <div class="mt-4 grid gap-3 sm:grid-cols-2"><label><span class="field-label">隊伍全名</span><input v-model="team.name" class="field" required maxlength="100" autocomplete="organization" /></label><label><span class="field-label">隊伍簡稱</span><input v-model="team.shortName" class="field" required maxlength="24" autocomplete="off" /></label></div>
    <div class="mt-5 space-y-2"><div class="flex items-center justify-between"><h3 class="text-sm font-semibold">Roster</h3><button type="button" class="button-secondary px-3 py-1.5 text-xs" @click="$emit('add')">新增球員</button></div><div v-for="(row, index) in team.roster" :key="index" class="grid grid-cols-[1fr_7rem_auto] gap-2"><input v-model="row.name" class="field" placeholder="姓名" required maxlength="80" autocomplete="name" /><input v-model="row.jerseyNumber" class="field" placeholder="背號" required maxlength="3" inputmode="numeric" pattern="[0-9]+" autocomplete="off" /><button type="button" class="icon-button" :aria-label="`移除第 ${index + 1} 位球員`" :disabled="team.roster.length === 1" @click="$emit('remove', index)">×</button></div></div>
  </section>
</template>
