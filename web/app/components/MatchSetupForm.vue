<script setup lang="ts">
import type { CreateMatchSetupInput, RosterInput } from '../lib/coreDomain'
import { validateMatchSetup } from '../utils/matchSetup'
import UiButton from '~/components/ui/Button.vue'

const props = withDefaults(defineProps<{ pending: boolean; error: Error | null; compact?: boolean }>(), { compact: false })
const emit = defineEmits<{ submit: [input: CreateMatchSetupInput]; cancel: [] }>()

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
  <form class="match-setup" :class="{ compact: props.compact }" :aria-busy="props.pending" @submit.prevent="submit">
    <div class="match-fields">
      <label class="block md:col-span-1"><span class="field-label">場次名稱</span><input v-model="title" class="field" required maxlength="120" autocomplete="off" placeholder="例如：大專盃準決賽" /></label>
      <label class="block"><span class="field-label">場地（選填）</span><input v-model="venue" class="field" maxlength="160" autocomplete="off" placeholder="場館名稱" /></label>
      <label class="block"><span class="field-label">預定時間（選填）</span><input v-model="scheduledAt" class="field" type="datetime-local" autocomplete="off" /></label>
    </div>

    <div class="team-grid">
      <TeamSetupCard v-model="leftTeam" label="左側隊伍" @add="addRosterRow(leftTeam)" @remove="removeRosterRow(leftTeam, $event)" />
      <TeamSetupCard v-model="rightTeam" label="右側隊伍" @add="addRosterRow(rightTeam)" @remove="removeRosterRow(rightTeam, $event)" />
    </div>

    <div v-if="validationErrors.length || props.error" class="match-errors" role="alert" aria-live="polite">
      <p class="font-semibold">建立前需要處理以下問題</p>
      <ul class="mt-2 list-disc space-y-1 pl-5"><li v-for="message in validationErrors" :key="message">{{ message }}</li></ul>
      <p v-if="props.error" class="mt-2">{{ props.error.message }}</p>
    </div>

    <div class="match-actions">
      <UiButton variant="ghost" @click="emit('cancel')">取消</UiButton>
      <UiButton type="submit" :disabled="props.pending">{{ props.pending ? '建立中…' : '建立場次' }}</UiButton>
    </div>
  </form>
</template>

<style scoped>
.match-setup{display:grid;gap:14px;padding:14px;overflow:auto;color:#fafafa}.match-fields{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;padding:14px;border-radius:10px;background:#111113}.match-fields :deep(.field){border:1px solid #27272a;background:#18181b;color:#fafafa}.match-fields :deep(.field:focus){border-color:#71717a;box-shadow:0 0 0 2px #fafafa24}.team-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.match-errors{padding:12px;border-radius:9px;background:#2b1114;color:#fca5a5;font-size:.72rem}.match-actions{display:flex;justify-content:flex-end;gap:8px}.compact{max-height:calc(100dvh - 78px)}@media(max-width:760px){.match-fields,.team-grid{grid-template-columns:1fr}}
</style>
