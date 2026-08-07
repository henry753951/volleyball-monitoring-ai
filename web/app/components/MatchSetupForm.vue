<script setup lang="ts">
import type { CreateMatchSetupInput, RosterInput } from '../lib/coreDomain'
import { validateMatchSetup } from '../utils/matchSetup'

const props = defineProps<{ pending: boolean; error: Error | null }>()
const emit = defineEmits<{ submit: [input: CreateMatchSetupInput] }>()

const title = ref('')
const venue = ref('')
const scheduledAt = ref('')
const leftTeam = reactive({ name: '', shortName: '', roster: [{ name: '', jerseyNumber: '' }] as RosterInput[] })
const rightTeam = reactive({ name: '', shortName: '', roster: [{ name: '', jerseyNumber: '' }] as RosterInput[] })
const validationErrors = ref<string[]>([])

function addRosterRow(team: typeof leftTeam) {
  team.roster.push({ name: '', jerseyNumber: '' })
}

function removeRosterRow(team: typeof leftTeam, index: number) {
  if (team.roster.length > 1) team.roster.splice(index, 1)
}

function submit() {
  const input: CreateMatchSetupInput = {
    title: title.value.trim(),
    venue: venue.value.trim() || undefined,
    scheduledAt: scheduledAt.value ? new Date(scheduledAt.value).toISOString() : undefined,
    leftTeam: { name: leftTeam.name.trim(), shortName: leftTeam.shortName.trim(), roster: leftTeam.roster.map((row) => ({ name: row.name.trim(), jerseyNumber: row.jerseyNumber.trim() })) },
    rightTeam: { name: rightTeam.name.trim(), shortName: rightTeam.shortName.trim(), roster: rightTeam.roster.map((row) => ({ name: row.name.trim(), jerseyNumber: row.jerseyNumber.trim() })) },
  }
  validationErrors.value = validateMatchSetup(input)
  if (!validationErrors.value.length) emit('submit', input)
}
</script>

<template>
  <form class="space-y-5" @submit.prevent="submit">
    <div class="grid gap-4 rounded-3xl border border-stone-200 bg-white/90 p-5 shadow-sm backdrop-blur-xl md:grid-cols-3">
      <label class="block md:col-span-1"><span class="field-label">場次名稱</span><input v-model="title" class="field" required placeholder="例如：大專盃準決賽" /></label>
      <label class="block"><span class="field-label">場地（選填）</span><input v-model="venue" class="field" placeholder="場館名稱" /></label>
      <label class="block"><span class="field-label">預定時間（選填）</span><input v-model="scheduledAt" class="field" type="datetime-local" /></label>
    </div>

    <div class="grid gap-4 lg:grid-cols-2">
      <TeamSetupCard v-model="leftTeam" label="左側隊伍" @add="addRosterRow(leftTeam)" @remove="removeRosterRow(leftTeam, $event)" />
      <TeamSetupCard v-model="rightTeam" label="右側隊伍" @add="addRosterRow(rightTeam)" @remove="removeRosterRow(rightTeam, $event)" />
    </div>

    <div v-if="validationErrors.length || props.error" class="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800" role="alert">
      <p class="font-semibold">建立前需要處理以下問題</p>
      <ul class="mt-2 list-disc space-y-1 pl-5"><li v-for="message in validationErrors" :key="message">{{ message }}</li></ul>
      <p v-if="props.error" class="mt-2">{{ props.error.message }}</p>
    </div>

    <div class="flex items-center justify-end gap-3">
      <NuxtLink to="/" class="button-secondary">取消</NuxtLink>
      <button class="button-primary" type="submit" :disabled="props.pending">{{ props.pending ? '建立中…' : '建立場次' }}</button>
    </div>
  </form>
</template>
