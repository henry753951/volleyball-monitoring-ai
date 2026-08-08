<script setup lang="ts">
import { Plus, Save, Trash2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import UiButton from '~/components/ui/Button.vue'
import type { Match, RosterEditInput } from '~/lib/coreDomain'

const props = defineProps<{ open: boolean; match: Match }>()
const emit = defineEmits<{ close: []; changed: [] }>()
const domain = useCoreDomain()
const activeTeamId = ref('')
const rowsByTeam = reactive<Record<string, Array<RosterEditInput & { rowKey: string }>>>({})
const pending = ref(false)
const error = ref<string | null>(null)
const saved = ref(false)
let rowSequence = 0

const activeTeam = computed(() => props.match.teams.find(team => team.id === activeTeamId.value) ?? props.match.teams[0])
const rows = computed(() => activeTeam.value ? (rowsByTeam[activeTeam.value.id] ?? []) : [])

function newRow(row: RosterEditInput = { jerseyNumber: '', name: '' }) {
  rowSequence += 1
  return { ...row, rowKey: row.id ?? `new-${rowSequence}` }
}

function hydrate(match: Match) {
  for (const team of match.teams) {
    rowsByTeam[team.id] = match.rosterEntries
      .filter(entry => entry.teamId === team.id)
      .map(entry => newRow({ id: entry.id, jerseyNumber: entry.jerseyNumber, name: entry.name }))
  }
  activeTeamId.value = match.teams.some(team => team.id === activeTeamId.value)
    ? activeTeamId.value
    : match.teams[0]?.id ?? ''
}

watch(() => [props.open, props.match.id] as const, ([open]) => {
  if (!open) return
  error.value = null
  saved.value = false
  hydrate(props.match)
}, { immediate: true })

function addPlayer() {
  if (!activeTeam.value) return
  rowsByTeam[activeTeam.value.id] ??= []
  rowsByTeam[activeTeam.value.id]!.push(newRow())
  saved.value = false
}

function removePlayer(index: number) {
  if (!activeTeam.value) return
  rowsByTeam[activeTeam.value.id]?.splice(index, 1)
  saved.value = false
}

async function save() {
  const team = activeTeam.value
  if (!team || pending.value) return
  const roster = rows.value.map(({ rowKey: _rowKey, ...row }) => ({
    ...(row.id ? { id: row.id } : {}),
    jerseyNumber: row.jerseyNumber.trim(),
    name: row.name.trim(),
  }))
  if (roster.some(row => !row.name || !row.jerseyNumber)) {
    error.value = '請填寫球員姓名與背號。'
    return
  }
  pending.value = true
  error.value = null
  saved.value = false
  try {
    const updated = await domain.updateMatchRoster({ matchId: props.match.id, roster, teamId: team.id })
    hydrate(updated)
    saved.value = true
    emit('changed')
    toast.success('球員名單已儲存')
  }
  catch (cause) {
    error.value = cause instanceof Error ? cause.message : '無法儲存名單'
    toast.error(error.value)
  }
  finally { pending.value = false }
}
</script>

<template>
  <UiAnimatedModal :open="open" title="球員名單" :description="match.title" @close="emit('close')">
    <div class="roster-dialog">
        <nav aria-label="選擇隊伍">
          <UiButton v-for="team in match.teams" :key="team.id" :variant="team.id === activeTeam?.id ? 'secondary' : 'ghost'" :class="{ active: team.id === activeTeam?.id }" @click="activeTeamId = team.id; error = null; saved = false">
            <b>{{ team.shortName }}</b><span>{{ team.name }}</span>
          </UiButton>
        </nav>

        <UiScrollArea class="roster-table">
          <div class="roster-table__inner">
            <div class="roster-table__head"><span>背號</span><span>球員</span><span /></div>
            <div v-for="(row, index) in rows" :key="row.rowKey" class="roster-row">
              <input v-model="row.jerseyNumber" :aria-label="`第 ${index + 1} 位球員背號`" maxlength="12" placeholder="00" @input="saved = false" />
              <input v-model="row.name" :aria-label="`第 ${index + 1} 位球員姓名`" maxlength="120" placeholder="球員姓名" @input="saved = false" />
              <UiButton variant="ghost" size="icon-sm" :aria-label="`移除 ${row.name || `第 ${index + 1} 位球員`}`" @click="removePlayer(index)"><Trash2 :size="15" /></UiButton>
            </div>
            <UiButton class="add" variant="ghost" size="sm" @click="addPlayer"><Plus :size="15" />新增球員</UiButton>
          </div>
        </UiScrollArea>
    </div>
    <template #footer>
      <span v-if="error" class="error" role="alert">{{ error }}</span><span v-else-if="saved" class="saved">已儲存</span><span class="footer-spacer" />
      <UiButton :disabled="pending" @click="save"><Save :size="15" />{{ pending ? '儲存中…' : '儲存名單' }}</UiButton>
    </template>
  </UiAnimatedModal>
</template>

<style scoped>
.roster-dialog{min-height:0;background:#09090b;color:#fafafa}.roster-dialog nav{display:flex;gap:6px;padding:12px 14px 0}.roster-dialog nav :deep(button){min-width:0;flex:1;justify-content:flex-start;text-align:left}.roster-dialog nav :deep(button.active){background:#27272a;color:#fafafa}.roster-dialog nav b{font-size:.75rem}.roster-dialog nav span{overflow:hidden;color:#a1a1aa;font-size:.66rem;text-overflow:ellipsis;white-space:nowrap}.roster-table{height:min(430px,calc(86dvh - 180px));margin-top:10px}.roster-table__inner{padding:0 14px 16px}.roster-table__head,.roster-row{display:grid;grid-template-columns:82px minmax(0,1fr) 34px;align-items:center;gap:7px}.roster-table__head{height:26px;padding:0 7px;color:#71717a;font-size:.61rem;font-weight:700}.roster-row{margin-bottom:6px}.roster-row input{width:100%;height:36px;padding:0 10px;border:1px solid #27272a;border-radius:8px;outline:0;background:#18181b;color:#fafafa;font-size:.72rem}.roster-row input:focus{border-color:#71717a;box-shadow:0 0 0 2px #fafafa24}.roster-row :deep(button){color:#a1a1aa}.roster-row :deep(button:hover){background:#2b1114;color:#fca5a5}.add{margin-top:4px}.error{margin-right:auto;color:#fca5a5;font-size:.68rem}.saved{margin-right:auto;color:#86efac;font-size:.68rem}.footer-spacer{flex:1}@media(max-width:560px){.roster-dialog nav span{display:none}}
</style>
